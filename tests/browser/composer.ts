import { composerHasPrompt, createAutoCloseCheck, insertPrompt, runDispatch, waitFor } from "../../src/content";
import type { ContentMessage, DispatchPayload, DispatchResponse } from "../../src/types";
import { buildPrompt, DEFAULT_SETTINGS } from "../../src/prompt";
import {
  countStartedAssistantMessages, findComposer, findObservationRoot,
  findResponseStopButton, findSendButton, isModelSelectorEnabled, readComposerText
} from "../../src/selectors";

function editableTextbox(): HTMLDivElement {
  const composer = document.createElement("div");
  composer.contentEditable = "true";
  composer.setAttribute("role", "textbox");
  return composer;
}

// Run in real Chromium via scripts/test-composer-browser.mjs, not Node's DOM mocks.
export function checkComposerInsertion(): { checks: number; browser: string } {
  const nativeExecCommand = document.execCommand;
  const page = document.createElement("div");
  page.setAttribute("data-app-shell-active-page", "true");
  page.innerHTML = "<main><form></form></main>";
  const form = page.querySelector("form")!;
  let checks = 0;
  const verify = (condition: boolean, label: string): void => {
    if (!condition) throw new Error(label);
    checks += 1;
  };

  try {
    const composer = document.createElement("div");
    composer.contentEditable = "true";
    composer.style.whiteSpace = "break-spaces";
    document.body.append(composer);
    try {
      // Observed live ChatGPT deep-link prefill: paragraphs with an empty
      // paragraph placeholder, not the single <p> produced by our fallback.
      composer.innerHTML = '<p>First paragraph.</p><p data-empty-paragraph="true">' +
        '<br class="ProseMirror-trailingBreak"></p><p>Second paragraph.</p>';
      verify(composerHasPrompt(composer, "First paragraph.\n\nSecond paragraph."),
        "observed ChatGPT paragraphs: exact prompt mismatch");
      verify(!composerHasPrompt(composer, "First paragraph.\nSecond paragraph."),
        "observed ChatGPT paragraphs: missing blank line accepted");
      verify(!composerHasPrompt(composer, "First paragraph. Second paragraph."),
        "observed ChatGPT paragraphs: collapsed prompt accepted");
      composer.innerHTML = '<p>First paragraph.</p><p>Second paragraph.</p>';
      verify(composerHasPrompt(composer, "First paragraph.\nSecond paragraph."),
        "adjacent paragraphs: single line break mismatch");
      composer.innerHTML = '<p>First paragraph.<br>Second paragraph.' +
        '<br class="ProseMirror-trailingBreak"></p>';
      verify(composerHasPrompt(composer, "First paragraph.\nSecond paragraph."),
        "hard line break: placeholder counted as content");
      Object.defineProperty(composer, "innerText", {
        get() { throw new Error("paragraph verification must not depend on layout text"); }
      });
      composer.replaceChildren(...DEFAULT_SETTINGS.optionalText.split("\n").map((line) => {
        const paragraph = document.createElement("p");
        paragraph.textContent = line;
        if (!line) {
          const placeholder = document.createElement("br");
          placeholder.className = "ProseMirror-trailingBreak";
          paragraph.append(placeholder);
        }
        return paragraph;
      }));
      verify(composerHasPrompt(composer, DEFAULT_SETTINGS.optionalText),
        "default prompt: logical paragraphs mismatch");
      const url = "https://www.seangoedecke.com/taste/";
      const richLink = `<span text-link-href="${url}" data-appearance="inline-mention" ` +
        'data-layout="inline-flow" data-breakable-url><span class="label">' +
        '<span data-inline-url-icon aria-hidden="true" contenteditable="false">' +
        '<span contenteditable="false"><svg><path></path></svg></span><span></span></span>' +
        `${url}</span></span>`;
      composer.innerHTML = `<p>${richLink}<br><br>Instructions.</p>`;
      verify(composerHasPrompt(composer, `${url}\n\nInstructions.`),
        "observed inline URL icon and label: exact prompt mismatch");
      composer.innerHTML = `<p>${richLink}</p><p><span>Instructions.</span></p>`;
      verify(composerHasPrompt(composer, `${url}\nInstructions.`),
        "observed inline span: exact prompt mismatch");
      verify(!composerHasPrompt(composer, `${url}\n\nInstructions.`),
        "rich links must not hide missing blank lines");
      const link = composer.querySelector("[text-link-href]");
      if (!link) throw new Error("Missing rich-link fixture");
      link.setAttribute("style", "display:block");
      verify(readComposerText(composer) === null, "unrecognized rich-link attributes accepted");
      link.removeAttribute("style");
      link.setAttribute("text-link-href", "https://example.com/other");
      verify(readComposerText(composer) === null, "mismatched link target accepted");
      composer.innerHTML = `<p>${richLink}</p>`;
      const icon = composer.querySelector("[data-inline-url-icon]");
      if (!icon) throw new Error("Missing icon fixture");
      icon.append("Unexpected text");
      verify(readComposerText(composer) === null, "nonempty icon silently omitted");
      for (const unrecognized of [
        '<span contenteditable="false">Instructions.</span>',
        '<span style="display:block">Instructions.</span>',
        '<span><img alt="unverified content"></span>',
        '<span data-inline-url-icon aria-hidden="true" contenteditable="false"></span>'
      ]) {
        composer.innerHTML = `<p>${unrecognized}</p>`;
        verify(readComposerText(composer) === null, "unrecognized span content accepted");
      }
      composer.innerHTML = '<p>First paragraph.<img alt="unverified content"></p>';
      verify(!composerHasPrompt(composer, "First paragraph."),
        "unsupported paragraph content accepted");
    } finally {
      composer.remove();
    }

    document.body.append(page);
    for (const fallback of [false, true]) {
      let nativeAttempts = 0;
      document.execCommand = (...args) => {
        nativeAttempts += 1;
        return fallback ? false : nativeExecCommand.apply(document, args);
      };
      for (const kind of ["textarea", "contenteditable"] as const) {
        for (const whiteSpace of ["normal", "pre-wrap"]) {
          const composer = kind === "textarea" ? document.createElement("textarea") : editableTextbox();
          if (composer instanceof HTMLTextAreaElement) composer.name = "prompt";
          composer.style.whiteSpace = whiteSpace;
          form.append(composer);
          const label = `${kind}/${whiteSpace}/fallback=${fallback}`;
          try {
            // Reset between dispatches: only initially empty composers may be written.
            for (const prompt of [
              "Single-line insertion.",
              buildPrompt("https://example.com/article", {
                optionalText: "Explain the risks.",
                placement: "append"
              }),
              "First paragraph.\n\nSecond paragraph.\nThird line.",
              "Replacement.\n\nLiteral <b>text</b> & symbols.",
              "Reuse.\n\nFinal paragraph."
            ]) {
              if (composer instanceof HTMLTextAreaElement) composer.value = "";
              else composer.replaceChildren();
              const before = nativeAttempts;
              insertPrompt(composer, prompt, () => {});
              if (kind === "contenteditable" && !prompt.includes("\n")) {
                verify(nativeAttempts === before + 1, `${label}: native insertion not attempted`);
                verify(!!composer.querySelector("p") === fallback, `${label}: unexpected single-line fallback`);
              }
              verify(composerHasPrompt(composer, prompt), `${label}: exact prompt mismatch`);
              verify(composer.querySelector("b") === null, `${label}: text interpreted as HTML`);
              if (prompt.includes("\n\n")) {
                verify(!composerHasPrompt(composer, prompt.replace(/\n+/g, " ")),
                  `${label}: collapsed prompt accepted`);
                verify(!composerHasPrompt(composer, prompt.replace(/\n\n/g, "\n")),
                  `${label}: missing blank line accepted`);
              }
            }
          } finally {
            composer.remove();
          }
        }
      }
    }
    // Synchronous editor callbacks can restore a draft during focus or native input.
    for (const phase of ["focus", "input", "failed command"]) {
      for (const markup of ["Different draft", '<img alt="unreadable draft">', " "]) {
        const composer = editableTextbox();
        form.append(composer);
        const restore = (): void => { composer.innerHTML = markup; };
        if (phase !== "failed command") composer.addEventListener(phase, restore, { once: true });
        let attempts = 0;
        document.execCommand = (...args) => {
          attempts += 1;
          if (phase === "failed command") { restore(); return false; }
          return nativeExecCommand.apply(document, args);
        };
        insertPrompt(composer, "Do not overwrite", () => {});
        verify(composer.innerHTML === markup, `${phase}: existing draft overwritten`);
        verify(attempts === (phase === "focus" ? 0 : 1), `${phase}: unexpected native command count`);
        composer.remove();
      }
    }
    // Building a detached multiline paragraph can consume the remaining lease.
    const composerForExpiry = editableTextbox();
    form.append(composerForExpiry);
    const innerText = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "innerText")!;
    let expired = false;
    const expiry = new Error("Fixture lease expired");
    try {
      Object.defineProperty(HTMLElement.prototype, "innerText", { ...innerText, set(value: string) {
        innerText.set!.call(this, value);
        expired = true;
      } });
      insertPrompt(composerForExpiry, "First\nSecond", () => { if (expired) throw expiry; });
    } catch (error) {
      if (error !== expiry) throw error;
    } finally {
      Object.defineProperty(HTMLElement.prototype, "innerText", innerText);
    }
    verify(expired && !composerForExpiry.hasChildNodes(), "expired lease wrote the prepared paragraph");
    composerForExpiry.remove();

    for (const phase of ["focus", "failed command"]) {
      const composer = editableTextbox();
      form.append(composer);
      const replacement = composer.cloneNode() as HTMLElement;
      replacement.textContent = "Other draft";
      const switchComposer = (): void => { form.prepend(replacement); };
      if (phase === "focus") composer.addEventListener("focus", switchComposer, { once: true });
      let attempts = 0;
      document.execCommand = () => { attempts += 1; switchComposer(); return false; };
      insertPrompt(composer, "Single line", () => {});
      verify(findComposer() === replacement, `${phase}: fixture did not change active composer`);
      verify(readComposerText(composer) === "" && replacement.textContent === "Other draft",
        `${phase}: inactive or replacement composer overwritten`);
      verify(attempts === (phase === "focus" ? 0 : 1), `${phase}: unexpected native command count`);
      composer.remove();
      replacement.remove();
    }
  } finally {
    page.remove();
    document.execCommand = nativeExecCommand;
  }
  return { checks, browser: navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] ?? "unknown" };
}

export async function checkActivePageSelectors(): Promise<{ checks: number }> {
  let checks = 0;
  const verify = (condition: boolean, label: string): void => {
    if (!condition) throw new Error(label);
    checks += 1;
  };
  const fixture = document.createElement("div");
  const page = (active: boolean, response: string): string => `
    <div data-app-shell-active-page="${active}"><main>
      <form data-chatgpt-composer>
        <div data-composer-markdown contenteditable="true" role="textbox"><p>Draft</p></div>
        <button type="button" aria-label="Select ChatGPT model">Model</button>
        <button type="submit">Send</button><button type="button" aria-label="Stop"></button>
      </form>
      <div data-chatgpt-conversation-selection-target><div data-turn-key="turn">
        <div data-markdown-text-style="assistant-message">${response}</div>
      </div></div>
    </main></div>`;
  // The app retains the old home page before the active conversation in DOM order.
  fixture.innerHTML = page(false, "Earlier response") + page(true, "");
  document.body.append(fixture);
  const inactive = fixture.children[0] as HTMLElement;
  const active = fixture.children[1] as HTMLElement;
  const activeMain = active.querySelector("main");
  const composer = active.querySelector<HTMLElement>("[contenteditable]");
  if (!composer || !activeMain) throw new Error("Invalid active-page fixture");
  try {
    verify(findComposer() === composer, "retained inactive composer selected");
    verify(findObservationRoot() === activeMain, "inactive main observed");
    verify(findSendButton(composer) === active.querySelector('button[type="submit"]'),
      "Send control escaped active form");
    verify(findResponseStopButton(composer) === active.querySelector('[aria-label="Stop"]'),
      "Stop control escaped active form");
    verify(isModelSelectorEnabled(composer), "active model selector not recognized");
    const model = active.querySelector<HTMLButtonElement>('[aria-label="Select ChatGPT model"]');
    if (!model) throw new Error("Missing model fixture");
    model.disabled = true;
    verify(!isModelSelectorEnabled(composer), "inactive model masked disabled active model");
    model.disabled = false;
    model.setAttribute("aria-disabled", "true");
    verify(!isModelSelectorEnabled(composer), "aria-disabled model accepted");
    model.remove();
    verify(!isModelSelectorEnabled(composer), "missing active model accepted");
    verify(countStartedAssistantMessages() === 0, "inactive response counted");
    const markdown = active.querySelector('[data-markdown-text-style="assistant-message"]');
    if (!markdown) throw new Error("Missing assistant fixture");
    markdown.textContent = "New response";
    verify(countStartedAssistantMessages() === 1, "active response not counted");

    // Neither retained DOM nor its controls may qualify when no page is active.
    active.setAttribute("data-app-shell-active-page", "false");
    verify(findComposer() === null, "inactive-only DOM produced a composer");
    verify(findObservationRoot() === document, "missing active main must observe document");
    verify(countStartedAssistantMessages() === 0, "inactive-only response counted");
    verify(createAutoCloseCheck(0)() === null, "inactive-only DOM qualified for closing");
    active.setAttribute("data-app-shell-active-page", "true");

    // A page switch leaves the old main connected. After polling rebinds, a
    // mutation in the newly active main must wake the wait without another poll.
    let reads = 0;
    let accept = false;
    const pending = waitFor(() => { reads += 1; return accept ? true : null; }, Date.now() + 2_000);
    active.setAttribute("data-app-shell-active-page", "false");
    inactive.setAttribute("data-app-shell-active-page", "true");
    await new Promise((resolve) => setTimeout(resolve, 300));
    verify(activeMain.isConnected, "fixture detached the old main");
    const before = reads;
    accept = true;
    inactive.querySelector("main")?.append(document.createElement("span"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const mutationObserved = reads > before;
    await pending;
    verify(mutationObserved, "observer stayed on the retained inactive main");
  } finally {
    fixture.remove();
  }
  return { checks };
}

const BENCHMARK_CLOSE_PATH = "/c/12345678-1234-1234-1234-123456789abc";
type SubmissionResult = { arms: number; submissions: number; confirmations: number; completions: number; failures: number };
type RunSubmission = (options?: {
  onArm?: () => void | Promise<void>; prompt?: string; autoClose?: boolean
}) => Promise<SubmissionResult>;

function waitForVisibility(hidden: boolean): Promise<void> {
  if (document.hidden === hidden) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const changed = (): void => {
      if (document.hidden !== hidden) return;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", changed);
      resolve();
    };
    const timer = setTimeout(() => {
      document.removeEventListener("visibilitychange", changed);
      reject(new Error("The Chromium fixture did not reach the expected visibility"));
    }, 5_000);
    document.addEventListener("visibilitychange", changed);
  });
}

async function withSubmissionFixture<T>(check: (run: RunSubmission, foreground: Window, form: HTMLFormElement) => Promise<T>): Promise<T> {
  if (document.hidden || location.pathname !== "/" || !("navigation" in window)) {
    throw new Error("Expected a visible new-chat root with the Navigation API");
  }
  // Keep this evaluation running in the original tab after a real tab switch.
  const foreground = window.open("about:blank", "_blank");
  if (!foreground) throw new Error("The Chromium fixture could not open a foreground tab");
  const fixture = document.createElement("div");
  fixture.setAttribute("data-app-shell-active-page", "true");
  fixture.innerHTML = '<main><form><textarea name="prompt"></textarea>' +
    '<button type="button" aria-label="Select ChatGPT model">Model</button>' +
    '<button type="submit">Send</button></form></main>';
  document.body.append(fixture);
  const textarea = fixture.querySelector("textarea");
  const form = fixture.querySelector("form");
  const send = fixture.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (!textarea || !form || !send) throw new Error("Invalid submission benchmark fixture");
  const originalRuntime = Object.getOwnPropertyDescriptor(chrome, "runtime");
  const stop = document.createElement("button");
  stop.type = "button";
  stop.setAttribute("aria-label", "Stop");
  let result: SubmissionResult;
  let dispatch: DispatchPayload;
  let onArm: (() => void | Promise<void>) | undefined;
  let hookFinished = false;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    result.submissions += 1;
    if (textarea.value !== dispatch.prompt) throw new Error("Incorrect submitted prompt");
    textarea.value = "";
    if (dispatch.autoClose) {
      // The cleared draft confirms the click first; a later mutation wakes response observation.
      queueMicrotask(() => {
        send.replaceWith(stop);
        history.replaceState(null, "", BENCHMARK_CLOSE_PATH);
      });
    }
  });
  Object.defineProperty(chrome, "runtime", {
    configurable: true,
    value: { async sendMessage(message: ContentMessage): Promise<DispatchResponse> {
      if (message.type === "claim-dispatch") return { ok: true, dispatch };
      if (message.type === "check-insertion") {
        const composer = findComposer();
        if (composer && readComposerText(composer) === "") return { ok: true };
        throw new Error("Unexpected insertion check on a prefilled fixture");
      }
      if (message.type === "arm-dispatch") {
        result.arms += 1;
        if (onArm) {
          await onArm();
          hookFinished = true;
        }
        const expiresAt = dispatch.autoClose ? Date.now() + 120_000 : dispatch.expiresAt;
        return { ok: true, dispatch: { ...dispatch, status: "submitting", expiresAt } };
      }
      if (message.type === "fail-dispatch") result.failures += 1;
      else if (message.type === "confirm-dispatch" && dispatch.autoClose && result.submissions === 1) {
        result.confirmations += 1;
      } else if (message.type === "complete-dispatch" && message.closeTab === dispatch.autoClose &&
        message.closePath === (dispatch.autoClose ? BENCHMARK_CLOSE_PATH : undefined) &&
        result.confirmations === Number(dispatch.autoClose)) {
        result.completions += 1;
      } else throw new Error("Unexpected benchmark dispatch message");
      return { ok: true };
    } }
  });
  const run: RunSubmission = async ({
    onArm: hook, prompt = "https://example.com/article\n\nSynthetic benchmark prompt.", autoClose = false
  } = {}) => {
    onArm = hook;
    hookFinished = false;
    result = { arms: 0, submissions: 0, confirmations: 0, completions: 0, failures: 0 };
    textarea.value = prompt;
    dispatch = {
      id: "benchmark", prompt, status: "claimed", createdAt: Date.now(),
      expiresAt: Date.now() + 15_000, autoSubmit: true, autoClose
    };
    await runDispatch(dispatch.id);
    if (autoClose) {
      stop.replaceWith(send);
      history.replaceState(null, "", "/");
    }
    if (hook && !hookFinished) throw new Error("The takeover fixture failed before replying to arm");
    if (textarea.value !== (result.submissions === 0 ? prompt : "")) {
      throw new Error("Submission fixture draft mismatch");
    }
    return result;
  };
  try {
    await waitForVisibility(true);
    return await check(run, foreground, form);
  } finally {
    foreground.close();
    fixture.remove();
    if (originalRuntime) Object.defineProperty(chrome, "runtime", originalRuntime);
    else Reflect.deleteProperty(chrome, "runtime");
  }
}

export async function checkSubmissionTakeover(): Promise<{ checks: number }> {
  return await withSubmissionFixture(async (run, foreground, form) => {
    const leaveAndReturn = (): void => {
      history.replaceState(null, "", "/unrelated");
      history.replaceState(null, "", "/");
    };
    const verifyFailure = (result: SubmissionResult, expectedArms: number): void => {
      if (result.arms !== expectedArms || result.submissions !== 0 || result.confirmations !== 0 ||
        result.completions !== 0 || result.failures !== 1) {
        throw new Error("Target takeover did not fail closed: " + JSON.stringify(result));
      }
    };
    verifySubmission(await run());
    for (const phase of ["native input", "failed command"]) {
      const composer = editableTextbox();
      form.prepend(composer);
      const native = document.execCommand;
      let takeovers = 0;
      const takeOver = (): void => {
        takeovers += 1;
        leaveAndReturn();
      };
      try {
        if (phase === "native input") composer.addEventListener("input", () => {
          composer.replaceChildren();
          takeOver();
        }, { once: true });
        else document.execCommand = () => { takeOver(); return false; };
        const result = await run({ prompt: "Single-line insertion" });
        verifyFailure(result, 0);
        if (takeovers !== 1 || composer.hasChildNodes()) {
          throw new Error(`${phase}: route takeover outcome: ${JSON.stringify({ takeovers, ...result, children: composer.childElementCount, empty: readComposerText(composer) === "" })}`);
        }
      } finally {
        composer.remove();
        document.execCommand = native;
      }
    }
    // Both same-document changes happen before the arm reply resolves.
    verifyFailure(await run({ onArm: leaveAndReturn }), 1);
    verifySubmission(await run({ onArm: async () => {
      foreground.close();
      await waitForVisibility(false);
    } }));
    return { checks: 5 };
  });
}

function verifySubmission(result: SubmissionResult, autoClose = false): void {
  if (result.arms !== 1 || result.submissions !== 1 || result.confirmations !== Number(autoClose) ||
    result.completions !== 1 || result.failures !== 0) {
    throw new Error("Submission did not complete exactly once: " + JSON.stringify(result));
  }
}

export async function benchmarkSubmission(): Promise<object> {
  const samples = 7;
  return await withSubmissionFixture(async (dispatch) => {
    const measure = async (autoClose: boolean, iterations: number, warmup: number) => {
      const run = async (count: number): Promise<void> => {
        for (let index = 0; index < count; index += 1) {
          verifySubmission(await dispatch({ autoClose }), autoClose);
        }
      };
      await run(warmup);
      const timings = [];
      for (let sample = 0; sample < samples; sample += 1) {
        const start = performance.now();
        await run(iterations);
        timings.push((performance.now() - start) * 1_000 / iterations);
      }
      timings.sort((left, right) => left - right);
      return { iterations, warmup, medianMicrosecondsPerDispatch: timings[Math.floor(samples / 2)] };
    };
    return {
      browser: navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0], samples,
      submitOnly: await measure(false, 100, 100),
      // Two real replaceState calls per trial. Stay below Chromium's navigation rate limit.
      confirmAndRequestClose: await measure(true, 5, 5)
    };
  });
}

export function benchmarkComposerReading(): object {
  const iterations = 10_000;
  const samples = 7;
  const warmup = 1_000;
  const results = [];
  const expected = DEFAULT_SETTINGS.optionalText;
  for (const kind of ["textarea", "contenteditable"] as const) {
    const composer = document.createElement(kind === "textarea" ? "textarea" : "div");
    if (composer instanceof HTMLTextAreaElement) {
      composer.value = expected;
    } else {
      composer.contentEditable = "true";
      composer.style.whiteSpace = "break-spaces";
      const paragraph = document.createElement("p");
      paragraph.innerText = expected;
      composer.append(paragraph);
    }
    document.body.append(composer);
    try {
      if (readComposerText(composer) !== expected) throw new Error(`${kind}: invalid benchmark output`);
      let checksum = 0;
      const run = (count: number): void => {
        for (let index = 0; index < count; index += 1) {
          checksum += readComposerText(composer)?.length ?? 0;
        }
      };
      run(warmup);
      const timings = [];
      for (let sample = 0; sample < samples; sample += 1) {
        const start = performance.now();
        run(iterations);
        timings.push((performance.now() - start) * 1_000_000 / iterations);
      }
      if (checksum !== expected.length * (warmup + samples * iterations)) {
        throw new Error(`${kind}: invalid benchmark checksum`);
      }
      timings.sort((left, right) => left - right);
      const median = timings[Math.floor(samples / 2)];
      if (median === undefined) throw new Error("Benchmark did not produce a median");
      results.push({ kind, medianNanoseconds: Math.round(median) });
    } finally {
      composer.remove();
    }
  }
  return { browser: navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0], iterations, samples, warmup, results };
}
