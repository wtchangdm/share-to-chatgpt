import { build } from "esbuild";

const ITERATIONS = 200_000;
const SAMPLES = 7;
const WARMUP_ITERATIONS = 20_000;

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
    if (selector === 'button[data-testid="send-button"]') {
      return this.sendButton;
    }
    if (selector === 'button[data-testid="stop-button"]') {
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
const assistantMessages = [
  { textContent: "Earlier response" },
  { textContent: " " },
  { textContent: "Current response" }
];

globalThis.document = {
  querySelector(selector) {
    return selector === "#prompt-textarea" ? composer : null;
  },
  querySelectorAll(selector) {
    return selector === '[data-message-author-role="assistant"]'
      ? assistantMessages
      : [];
  }
};

async function loadProductionSelectors() {
  const result = await build({
    entryPoints: ["src/selectors.ts"],
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

function observe(selectors) {
  const assistantCount = selectors.countStartedAssistantMessages();
  const currentComposer = selectors.findComposer();
  const sendButton = currentComposer
    ? selectors.findSendButton(currentComposer)
    : null;
  const sendButtonEnabled = sendButton
    ? selectors.isSendButtonEnabled(sendButton)
    : false;
  const composerForm = currentComposer
    ? selectors.findComposerForm(currentComposer)
    : null;
  const responseStreaming = composerForm
    ?.querySelector('button[data-testid="stop-button"]') === stopButton;
  return assistantCount + Number(currentComposer === composer) +
    Number(sendButtonEnabled) + Number(responseStreaming);
}

function runIterations(selectors, iterations) {
  let checksum = 0;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    checksum += observe(selectors);
  }
  return checksum;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

const selectors = await loadProductionSelectors();
const expected = 5;
const actual = observe(selectors);
if (actual !== expected) {
  throw new Error(`Observation produced ${actual}; expected ${expected}.`);
}

let checksum = runIterations(selectors, WARMUP_ITERATIONS);
const samples = [];
for (let sample = 0; sample < SAMPLES; sample += 1) {
  globalThis.gc?.();
  const startedAt = process.hrtime.bigint();
  checksum += runIterations(selectors, ITERATIONS);
  const elapsedNanoseconds = Number(process.hrtime.bigint() - startedAt);
  samples.push(elapsedNanoseconds / ITERATIONS);
}

if (checksum === 0) {
  throw new Error("Benchmark checksum was unexpectedly zero.");
}

const medianNanoseconds = median(samples);
console.log(`Node ${process.version} on ${process.platform}/${process.arch}`);
console.log(
  `${SAMPLES} samples × ${ITERATIONS.toLocaleString("en-US")} measured observations; ` +
  `${WARMUP_ITERATIONS.toLocaleString("en-US")} warmup observations.`
);
console.table([{
  scenario: "assistant-and-composer-ready",
  medianNanosecondsPerObservation: Math.round(medianNanoseconds),
  minimumNanosecondsPerObservation: Math.round(Math.min(...samples)),
  observationsPerSecond: Math.round(1_000_000_000 / medianNanoseconds)
}]);
