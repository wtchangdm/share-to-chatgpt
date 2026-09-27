import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  loadOptions,
  saveOptions,
  type OptionsFields,
  type SettingsStorage
} from "../src/options-model";
import { DEFAULT_SETTINGS, normalizeSettings } from "../src/prompt";

const defaultPrompt = `Start with a brief summary of the key takeaways, then analyze the page.

Distinguish what is established, what the page asserts or interprets, and what is speculative. Assess the strongest evidence and important caveats, and include meaningful counterarguments or missing context when relevant. Add external context or verification only when it materially improves understanding, using reliable sources and citing them.

Explain why it matters in context, and call out anything important, surprising, overstated, weakly supported, or easy to misunderstand. Suggest worthwhile follow-up reading only when useful.

Finally, tell me why this may matter to me, what I can learn from it, and recommend reading the original only if it adds substantial value beyond the summary.

Keep the depth proportional to the material. Don't manufacture false balance or turn a simple page into a long essay.`;

function optionsFields(): OptionsFields {
  return {
    optionalText: { value: "" },
    placement: { value: "prepend" },
    stripTrackingParameters: { checked: true },
    autoSubmit: { checked: true },
    autoClose: { checked: false, disabled: false },
    status: { textContent: "" }
  };
}

test("missing or invalid prompt settings use the exact default analysis prompt", () => {
  assert.equal(DEFAULT_SETTINGS.optionalText, defaultPrompt);
  for (const settings of [undefined, {}, { optionalText: 123 as unknown as string }]) {
    assert.equal(normalizeSettings(settings).optionalText, defaultPrompt);
  }
});

test("prompt defaults load without overwriting saved text or an intentionally empty prompt", async () => {
  let stored: Record<string, unknown> = {};
  const storage: SettingsStorage = {
    async get() { return stored; },
    async set(items) { stored = items; }
  };
  const fields = optionsFields();
  assert.equal(await loadOptions(fields, storage), true);
  assert.equal(fields.optionalText.value, defaultPrompt);
  assert.deepEqual(stored, {});

  for (const savedText of ["", "Custom instructions.\n\nKeep these paragraphs.", " \n "]) {
    fields.optionalText.value = savedText;
    assert.equal(await saveOptions(fields, storage, () => 0), true);
    const reopened = optionsFields();
    assert.equal(await loadOptions(reopened, storage), true);
    assert.equal(reopened.optionalText.value, savedText);
    assert.equal(normalizeSettings(stored.settings as { optionalText: string }).optionalText, savedText);
  }

  stored = {};
  assert.equal(await loadOptions(fields, storage), true);
  assert.equal(fields.optionalText.value, defaultPrompt);
});

test("tracking cleanup help is associated with its checkbox", () => {
  const html = readFileSync("options.html", "utf8");

  assert.match(
    html,
    /id="strip-tracking-parameters"[^>]*aria-describedby="strip-tracking-help"/
  );
  assert.match(html, /id="strip-tracking-help"/);
});

test("options load, dependency state, and save stay synchronized", async () => {
  const fields = optionsFields();
  let saved: Record<string, unknown> | undefined;
  const storage: SettingsStorage = {
    async get() {
      return {
        settings: {
          optionalText: "Review this",
          placement: "append",
          stripTrackingParameters: false,
          autoSubmit: false,
          autoClose: true
        }
      };
    },
    async set(items) {
      saved = items;
    }
  };

  assert.equal(await loadOptions(fields, storage), true);
  assert.equal(fields.optionalText.value, "Review this");
  assert.equal(fields.placement.value, "append");
  assert.equal(fields.stripTrackingParameters.checked, false);
  assert.equal(fields.autoSubmit.checked, false);
  assert.equal(fields.autoClose.checked, true);
  assert.equal(fields.autoClose.disabled, true);

  fields.autoSubmit.checked = true;
  let clearStatus: (() => void) | undefined;
  assert.equal(await saveOptions(fields, storage, (callback, delay) => {
    assert.equal(delay, 2_000);
    clearStatus = callback;
  }), true);
  assert.deepEqual(saved, {
    settings: {
      optionalText: "Review this",
      placement: "append",
      stripTrackingParameters: false,
      autoSubmit: true,
      autoClose: true
    }
  });
  assert.equal(fields.status.textContent, "Saved locally.");
  clearStatus?.();
  assert.equal(fields.status.textContent, "");
});
