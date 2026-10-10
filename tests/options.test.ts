import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  loadOptions,
  resetOptions,
  saveOptions,
  type OptionsFields,
  type SettingsStorage
} from "../src/options-model";
import { DEFAULT_SETTINGS, normalizeSettings } from "../src/prompt";

const defaultPrompt = `Read the linked page. Start with a brief summary of its main point, key findings, and significance.

Then add only analysis that materially improves my understanding. Consider what is established versus claimed, interpreted, or speculative; the strongest evidence and important limitations; meaningful counterarguments or missing context; and consequential, surprising, overstated, or easily misunderstood points. These are evaluation criteria, not required sections. Include a point only if it changes the takeaway, confidence in it, or understanding of how or why it matters.

Use reliable external sources when needed to verify a consequential claim or resolve an important gap, and cite sources used. Disclose material limits on access to the page rather than inventing its contents.

Briefly include personal relevance or a useful lesson when it adds something specific, using what you know about me without forcing a connection. Recommend the original or follow-up reading only when you can identify substantial value beyond this briefing.

Do not create or update memories or assumptions about me from this link or summary; base any memory or personal-context updates on personal information I provide in substantive follow-up discussion.

Keep the depth proportional to the material. Preserve central findings, essential explanations, and caveats that change the takeaway. Cut low-value or repetitive points rather than compressing useful explanations into dense prose.

Omit inapplicable categories, generic caveats, repeated conclusions, process preambles, and offers to continue. Do not manufacture false balance.`;

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

test("reset persists every default, preserves unrelated storage, and survives repeated use", async () => {
  let stored: Record<string, unknown> = { unrelated: "keep", settings: { autoSubmit: false } };
  const storage: SettingsStorage = {
    async get() { return stored; },
    async set(items) { stored = { ...stored, ...items }; }
  };
  const fields = optionsFields();
  await loadOptions(fields, storage);
  fields.optionalText.value = "Unsaved draft";
  for (let reset = 0; reset < 2; reset++) {
    let clearStatus: (() => void) | undefined;
    assert.equal(await resetOptions(fields, storage, (callback, delay) => {
      assert.equal(delay, 2_000);
      clearStatus = callback;
    }), true);
    assert.deepEqual(stored, { unrelated: "keep", settings: DEFAULT_SETTINGS });
    assert.equal(fields.optionalText.value, defaultPrompt);
    assert.equal(fields.placement.value, "append");
    assert.equal(fields.stripTrackingParameters.checked, true);
    assert.equal(fields.autoSubmit.checked, true);
    assert.equal(fields.autoClose.checked, true);
    assert.equal(fields.autoClose.disabled, false);
    assert.equal(fields.status.textContent, "Defaults restored.");
    clearStatus?.();
    assert.equal(fields.status.textContent, "");
    const reopened = optionsFields();
    assert.equal(await loadOptions(reopened, storage), true);
    assert.deepEqual(reopened, fields);
  }
});

test("failed reset retains fields and saved settings, and can recover", async () => {
  const fields = optionsFields();
  fields.optionalText.value = "Keep my draft";
  fields.autoSubmit.checked = false;
  fields.autoClose.disabled = true;
  const before = structuredClone(fields);
  let fail = true;
  let saved: Record<string, unknown> | undefined;
  const failure = new Error("Storage unavailable");
  const errors: unknown[] = [];
  const storage: SettingsStorage = {
    async get() { return {}; },
    async set(items) {
      if (fail) throw failure;
      saved = items;
    }
  };
  assert.equal(await resetOptions(fields, storage, () => {
    assert.fail("Failed reset must not schedule success cleanup");
  }, (_message, error) => errors.push(error)), false);
  assert.equal(saved, undefined);
  assert.deepEqual(errors, [failure]);
  assert.deepEqual(fields, { ...before, status: { textContent: "Could not reset settings." } });
  fail = false;
  assert.equal(await resetOptions(fields, storage, () => 0), true);
  assert.deepEqual(saved, { settings: DEFAULT_SETTINGS });
  assert.equal(fields.optionalText.value, defaultPrompt);
  assert.equal(fields.autoClose.disabled, false);
});

test("reset is an explicitly labeled non-submit button", () => {
  assert.match(readFileSync("options.html", "utf8"),
    /<button\s+id="reset-settings"\s+type="button">Reset to defaults<\/button>/);
});

test("placement defaults after the link without writes and preserves saved choices", async () => {
  let stored: Record<string, unknown> = {};
  const storage: SettingsStorage = {
    async get() { return stored; },
    async set(items) { stored = items; }
  };
  const fields = optionsFields();
  assert.equal(DEFAULT_SETTINGS.placement, "append");
  for (const settings of [undefined, {}]) {
    assert.equal(normalizeSettings(settings).placement, "append");
  }
  assert.equal(await loadOptions(fields, storage), true);
  assert.equal(fields.placement.value, "append");
  assert.deepEqual(stored, {});

  for (const placement of ["prepend", "append"] as const) {
    fields.placement.value = placement;
    assert.equal(await saveOptions(fields, storage, () => 0), true);
    for (let reload = 0; reload < 2; reload++) {
      const reopened = optionsFields();
      assert.equal(await loadOptions(reopened, storage), true);
      assert.equal(reopened.placement.value, placement);
    }
  }

  stored = {};
  assert.equal(await loadOptions(fields, storage), true);
  assert.equal(fields.placement.value, "append");
  assert.deepEqual(stored, {});
});

test("automatic closing defaults load without writes and preserve saved choices across reloads", async () => {
  let stored: Record<string, unknown> = {};
  const storage: SettingsStorage = {
    async get() { return stored; },
    async set(items) { stored = items; }
  };
  const fields = optionsFields();
  assert.equal(await loadOptions(fields, storage), true);
  assert.equal(fields.autoClose.checked, true);
  assert.equal(fields.autoClose.disabled, false);
  assert.deepEqual(stored, {});

  for (const autoClose of [false, true]) {
    fields.autoClose.checked = autoClose;
    assert.equal(await saveOptions(fields, storage, () => 0), true);
    for (let reload = 0; reload < 2; reload++) {
      const reopened = optionsFields();
      assert.equal(await loadOptions(reopened, storage), true);
      assert.equal(reopened.autoClose.checked, autoClose);
    }
  }

  stored = { settings: { autoSubmit: false } };
  assert.equal(await loadOptions(fields, storage), true);
  assert.equal(fields.autoClose.checked, true);
  assert.equal(fields.autoClose.disabled, true);
  assert.deepEqual(stored, { settings: { autoSubmit: false } });

  stored = {};
  assert.equal(await loadOptions(fields, storage), true);
  assert.equal(fields.autoClose.checked, true);
  assert.equal(fields.autoClose.disabled, false);
  assert.deepEqual(stored, {});
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
