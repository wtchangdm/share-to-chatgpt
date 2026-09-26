import { build } from "esbuild";

const ITERATIONS = 200_000;
const SAMPLES = 7;
const WARMUP_ITERATIONS = 20_000;
const BASELINE_ASSISTANT_MESSAGES = 200;
let productionSelectors;

class FakeHTMLElement {
  isContentEditable = false;

  getAttribute() {
    return null;
  }
}

class FakeHTMLButtonElement extends FakeHTMLElement {
  disabled = false;
}

class FakeHTMLFormElement extends FakeHTMLElement {
  constructor(sendButton, stopButton) {
    super();
    this.sendButton = sendButton;
    this.stopButton = stopButton;
  }

  querySelector(selector) {
    if (selector === productionSelectors.SEND_BUTTON_SELECTORS[0]) {
      return this.sendButton;
    }
    if (selector === productionSelectors.RESPONSE_STOP_BUTTON_SELECTOR) {
      return this.stopButton;
    }
    return null;
  }
}

class FakeHTMLTextAreaElement extends FakeHTMLElement {
  constructor(form) {
    super();
    this.form = form;
  }

  closest(selector) {
    return selector === "form" ? this.form : null;
  }
}

globalThis.HTMLElement = FakeHTMLElement;
globalThis.HTMLButtonElement = FakeHTMLButtonElement;
globalThis.HTMLFormElement = FakeHTMLFormElement;
globalThis.HTMLTextAreaElement = FakeHTMLTextAreaElement;

const button = new FakeHTMLButtonElement();
const stopButton = new FakeHTMLButtonElement();
const form = new FakeHTMLFormElement(button, stopButton);
const composer = new FakeHTMLTextAreaElement(form);
function assistantMarkdown(textContent) {
  const message = {};
  return {
    textContent,
    closest() {
      return message;
    }
  };
}

const assistantMessages = Array.from(
  { length: BASELINE_ASSISTANT_MESSAGES },
  (_, index) => assistantMarkdown(`Earlier response ${index}`)
);
assistantMessages.push(
  assistantMarkdown(" "),
  assistantMarkdown("Current response")
);
let assistantSelector;

globalThis.document = {
  querySelector() {
    return composer;
  },
  querySelectorAll(selector) {
    return selector === assistantSelector
      ? assistantMessages
      : [];
  }
};

async function loadProductionModules() {
  const result = await build({
    stdin: {
      contents: `
        import * as content from "./src/content.ts";
        export { content };
        export * from "./src/selectors.ts";
      `,
      resolveDir: process.cwd()
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node20",
    logLevel: "silent"
  });
  const source = result.outputFiles[0]?.text;
  if (!source) {
    throw new Error("esbuild did not produce benchmarkable output.");
  }

  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  return import(moduleUrl);
}

function createResponseStartedCheck(production, initialMessageCount) {
  return production.content.createAssistantResponseTracker(
    initialMessageCount,
    () => production.countStartedAssistantMessages()
  );
}

function observe(selectors, responseStarted) {
  const assistantResponseStarted = responseStarted();
  const currentComposer = selectors.findComposer();
  const sendButton = currentComposer
    ? selectors.findSendButton(currentComposer)
    : null;
  const sendButtonEnabled = sendButton
    ? selectors.isSendButtonEnabled(sendButton)
    : false;
  const responseStreaming = currentComposer
    ? selectors.findResponseStopButton(currentComposer) === stopButton
    : false;
  return Number(assistantResponseStarted) + Number(currentComposer === composer) +
    Number(sendButtonEnabled) + Number(responseStreaming);
}

function runIterations(selectors, responseStarted, iterations) {
  let checksum = 0;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    checksum += observe(selectors, responseStarted);
  }
  return checksum;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

const selectors = await loadProductionModules();
productionSelectors = selectors;
assistantSelector = selectors.ASSISTANT_MESSAGE_SELECTOR;
const results = [];
for (const scenario of [
  { name: "streaming-after-response-start", initialCount: BASELINE_ASSISTANT_MESSAGES, expected: 4 },
  { name: "awaiting-response-start", initialCount: BASELINE_ASSISTANT_MESSAGES + 1, expected: 3 }
]) {
  const responseStarted = createResponseStartedCheck(selectors, scenario.initialCount);
  const actual = observe(selectors, responseStarted);
  if (actual !== scenario.expected) {
    throw new Error(`Observation produced ${actual}; expected ${scenario.expected}.`);
  }

  let checksum = runIterations(selectors, responseStarted, WARMUP_ITERATIONS);
  const samples = [];
  for (let sample = 0; sample < SAMPLES; sample += 1) {
    globalThis.gc?.();
    const startedAt = process.hrtime.bigint();
    checksum += runIterations(selectors, responseStarted, ITERATIONS);
    const elapsedNanoseconds = Number(process.hrtime.bigint() - startedAt);
    samples.push(elapsedNanoseconds / ITERATIONS);
  }

  if (checksum !== scenario.expected * (WARMUP_ITERATIONS + SAMPLES * ITERATIONS)) {
    throw new Error("Benchmark checksum did not match the expected observations.");
  }

  const medianNanoseconds = median(samples);
  results.push({
    scenario: scenario.name,
    medianNanosecondsPerObservation: Math.round(medianNanoseconds),
    minimumNanosecondsPerObservation: Math.round(Math.min(...samples)),
    observationsPerSecond: Math.round(1_000_000_000 / medianNanoseconds)
  });
}
console.log(`Node ${process.version} on ${process.platform}/${process.arch}`);
console.log(
  `${SAMPLES} samples × ${ITERATIONS.toLocaleString("en-US")} measured observations; ` +
  `${WARMUP_ITERATIONS.toLocaleString("en-US")} warmup observations.`
);
console.table(results);
