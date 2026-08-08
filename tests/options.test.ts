import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  loadOptions,
  saveOptions,
  type OptionsFields,
  type SettingsStorage
} from "../src/options-model";

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
