import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildChatGPTUrl,
  buildPrompt,
  DEFAULT_SETTINGS,
  normalizeSettings
} from "../src/prompt";
import {
  ASSISTANT_MESSAGE_SELECTOR,
  SEND_BUTTON_SELECTORS
} from "../src/selectors";

const pageUrl = "https://example.com/articles/one?x=1&y=two#section";

test("the default prompt and deep link match the bookmarklet behavior", () => {
  const prompt = buildPrompt(pageUrl, DEFAULT_SETTINGS);

  assert.equal(prompt, pageUrl);
  assert.equal(
    buildChatGPTUrl(prompt),
    `https://chatgpt.com/?prompt=${encodeURIComponent(pageUrl)}`
  );
});

test("optional text can be prepended without creating a multiline prompt", () => {
  assert.equal(
    buildPrompt(pageUrl, { optionalText: "  Summarize this  ", placement: "prepend" }),
    `Summarize this ${pageUrl}`
  );
});

test("optional text can be appended without creating a multiline prompt", () => {
  assert.equal(
    buildPrompt(pageUrl, { optionalText: "Explain the risks", placement: "append" }),
    `${pageUrl} Explain the risks`
  );
});

test("line breaks in optional text are normalized for composer verification", () => {
  assert.equal(
    buildPrompt(pageUrl, { optionalText: "Compare\n\ncarefully", placement: "prepend" }),
    `Compare carefully ${pageUrl}`
  );
});

test("missing or invalid persisted settings fall back safely", () => {
  assert.deepEqual(
    normalizeSettings({ optionalText: "Question", placement: "invalid" as "append" }),
    {
      optionalText: "Question",
      placement: "prepend",
      autoSubmit: true,
      autoClose: false
    }
  );
});

test("automatic submission and closing settings are restored", () => {
  assert.deepEqual(
    normalizeSettings({ autoSubmit: false, autoClose: true }),
    {
      optionalText: "",
      placement: "prepend",
      autoSubmit: false,
      autoClose: true
    }
  );
});

test("a transient dispatch marker is added without changing the prompt query", () => {
  assert.equal(
    buildChatGPTUrl(pageUrl, "dispatch-123"),
    `https://chatgpt.com/?prompt=${encodeURIComponent(pageUrl)}` +
      "#share-to-chatgpt-dispatch=dispatch-123"
  );
});

test("automatic closing uses the scoped assistant-message marker", () => {
  assert.equal(
    ASSISTANT_MESSAGE_SELECTOR,
    '[data-message-author-role="assistant"]'
  );
});

test("the manifest requests only the required extension permissions", () => {
  const manifest = JSON.parse(readFileSync("manifest.json", "utf8")) as {
    permissions?: string[];
  };

  assert.deepEqual(manifest.permissions, ["activeTab", "contextMenus", "storage"]);
});

test("exact Send controls take priority over a generic submit button", () => {
  assert.deepEqual(SEND_BUTTON_SELECTORS, [
    'button[data-testid="send-button"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label="Send message"]',
    'button[type="submit"]'
  ]);
});
