import { composerHasPrompt, insertPrompt } from "../../src/content";
import { DEFAULT_SETTINGS } from "../../src/prompt";
import { readComposerText } from "../../src/selectors";

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
