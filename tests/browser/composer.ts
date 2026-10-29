import { composerHasPrompt, createAutoCloseCheck, insertPrompt, runDispatch, waitFor } from "../../src/content";
import type { ContentMessage, DispatchPayload, DispatchResponse } from "../../src/types";
import { buildPrompt, DEFAULT_SETTINGS } from "../../src/prompt";
import {
  countStartedAssistantMessages, findComposer, findObservationRoot,
  findResponseStopButton, findSendButton, isModelSelectorEnabled, readComposerText
} from "../../src/selectors";

// Run in real Chromium via scripts/test-composer-browser.mjs, not Node's DOM mocks.
export function checkComposerInsertion(): { checks: number; browser: string } {
  const nativeExecCommand = document.execCommand;
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

    for (const fallback of [false, true]) {
      document.execCommand = fallback ? () => false : nativeExecCommand;
      for (const kind of ["textarea", "contenteditable"] as const) {
        for (const whiteSpace of ["normal", "pre-wrap"]) {
          const composer = document.createElement(kind === "textarea" ? "textarea" : "div");
          if (kind === "contenteditable") composer.contentEditable = "true";
          composer.style.whiteSpace = whiteSpace;
          document.body.append(composer);
          const label = `${kind}/${whiteSpace}/fallback=${fallback}`;
          try {
            // First use, replacement, clearing, and reuse exercise selection/reset behavior.
            for (const prompt of [
              buildPrompt("https://example.com/article", {
                optionalText: "Explain the risks.",
                placement: "append"
              }),
              "First paragraph.\n\nSecond paragraph.\nThird line.",
              "Replacement.\n\nLiteral <b>text</b> & symbols.",
              "",
              "Reuse.\n\nFinal paragraph."
            ]) {
              insertPrompt(composer, prompt);
              verify(composerHasPrompt(composer, prompt), `${label}: exact prompt mismatch`);
              verify(composer.querySelector("b") === null, `${label}: text interpreted as HTML`);
              if (prompt) {
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
  } finally {
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

export async function benchmarkSubmission(): Promise<object> {
  const iterations = 100;
  const samples = 7;
  const warmup = 100;
  const fixture = document.createElement("div");
  fixture.setAttribute("data-app-shell-active-page", "true");
  fixture.innerHTML = '<main><form><textarea name="prompt"></textarea>' +
    '<button type="button" aria-label="Select ChatGPT model">Model</button>' +
    '<button type="submit">Send</button></form></main>';
  document.body.append(fixture);
  const textarea = fixture.querySelector("textarea");
  const form = fixture.querySelector("form");
  if (!textarea || !form) throw new Error("Invalid submission benchmark fixture");
  const originalRuntime = Object.getOwnPropertyDescriptor(chrome, "runtime");
  const prompt = "https://example.com/article\n\nSynthetic benchmark prompt.";
  let submissions = 0;
  let arms = 0;
  let completions = 0;
  let dispatch: DispatchPayload;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (textarea.value !== prompt) throw new Error("Incorrect submitted prompt");
    submissions += 1;
    textarea.value = "";
  });
  Object.defineProperty(chrome, "runtime", {
    configurable: true,
    value: { async sendMessage(message: ContentMessage): Promise<DispatchResponse> {
      if (message.type === "claim-dispatch") return { ok: true, dispatch };
      if (message.type === "arm-dispatch") arms += 1;
      else if (message.type === "complete-dispatch" && !message.closeTab) completions += 1;
      else throw new Error("Unexpected benchmark dispatch message");
      return { ok: true };
    } }
  });
  const run = async (count: number): Promise<void> => {
    for (let index = 0; index < count; index += 1) {
      textarea.value = prompt;
      dispatch = {
        id: "benchmark", prompt, status: "claimed", createdAt: Date.now(),
        expiresAt: Date.now() + 15_000, autoSubmit: true, autoClose: false
      };
      const before = completions;
      await runDispatch(dispatch.id);
      if (completions !== before + 1 || textarea.value !== "") {
        throw new Error("Benchmark dispatch did not complete");
      }
    }
  };
  try {
    await run(warmup);
    const timings = [];
    for (let sample = 0; sample < samples; sample += 1) {
      const start = performance.now();
      await run(iterations);
      timings.push((performance.now() - start) * 1_000 / iterations);
    }
    const expected = warmup + samples * iterations;
    if (submissions !== expected || arms !== expected || completions !== expected) {
      throw new Error("Submission benchmark checksum mismatch");
    }
    timings.sort((left, right) => left - right);
    return {
      browser: navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0], iterations, samples, warmup,
      medianMicrosecondsPerDispatch: timings[Math.floor(samples / 2)]
    };
  } finally {
    fixture.remove();
    if (originalRuntime) Object.defineProperty(chrome, "runtime", originalRuntime);
    else Reflect.deleteProperty(chrome, "runtime");
  }
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
