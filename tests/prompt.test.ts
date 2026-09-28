import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  armDispatch,
  canCompleteDispatch,
  claimDispatch,
  findExpiredDispatches
} from "../src/dispatch-policy";
import { getFailureActionTitle } from "../src/diagnostics";
import { getShortcutTargetUrl } from "../src/hovered-link";
import {
  loadOptions,
  saveOptions,
  type OptionsFields,
  type SettingsStorage
} from "../src/options-model";
import {
  buildChatGPTUrl,
  buildPrompt,
  DEFAULT_SETTINGS,
  normalizeSettings
} from "../src/prompt";
import {
  ASSISTANT_MESSAGE_SELECTOR,
  RESPONSE_STOP_BUTTON_SELECTOR,
  SEND_BUTTON_SELECTORS
} from "../src/selectors";
import { isSubmissionConfirmed } from "../src/submission";
import type { DispatchPayload } from "../src/types";

const pageUrl = "https://example.com/articles/one?x=1&y=two#section";
const urlOnlySettings = { ...DEFAULT_SETTINGS, optionalText: "" };

test("the default prompt and deep link preserve non-tracking query parameters", () => {
  const prompt = buildPrompt(pageUrl, DEFAULT_SETTINGS);

  const expected = `${pageUrl}\n\n${DEFAULT_SETTINGS.optionalText}`;
  assert.equal(prompt, expected);
  assert.equal(
    buildChatGPTUrl(prompt),
    `https://chatgpt.com/?prompt=${encodeURIComponent(expected)}`
  );
});

const trackingQueryParameters = [
  "utm_id",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_source_platform",
  "utm_term",
  "utm_content",
  "utm_creative_format",
  "utm_marketing_tactic",
  "gclid",
  "dclid",
  "gbraid",
  "wbraid",
  "gad_source",
  "gad_campaignid",
  "srsltid",
  "fbclid",
  "msclkid",
  "ttclid",
  "li_fat_id",
  "mc_cid",
  "mc_eid",
  "mc_tc"
] as const;

for (const parameter of trackingQueryParameters) {
  test(`the default cleanup strips ${parameter}`, () => {
    const trackedUrl =
      `https://example.com/article?article=42&${parameter}=tracking#comments`;

    assert.equal(
      buildPrompt(trackedUrl, urlOnlySettings),
      "https://example.com/article?article=42#comments"
    );
  });
}

test("cleanup preserves the original encoding of retained URL data", () => {
  const trackedUrl =
    "https://example.com/path?keep=~&space=%20&utm_source=x#frag";

  assert.equal(
    buildPrompt(trackedUrl, urlOnlySettings),
    "https://example.com/path?keep=~&space=%20#frag"
  );
});

test("cleanup removes duplicate and percent-encoded tracking parameter names", () => {
  const trackedUrl =
    "https://example.com/path?%75tm_source=first&keep=1&utm_source=second";

  assert.equal(
    buildPrompt(trackedUrl, urlOnlySettings),
    "https://example.com/path?keep=1"
  );
});

test("cleanup is case-sensitive and does not inspect URL fragments", () => {
  const value =
    "https://example.com/path?UTM_SOURCE=keep#?utm_source=fragment";

  assert.equal(buildPrompt(value, urlOnlySettings), value);
});

test("cleanup leaves malformed and non-HTTP URLs unchanged", () => {
  for (const value of [
    "not a URL?utm_source=keep",
    "chrome://extensions/?utm_source=keep"
  ]) {
    assert.equal(buildPrompt(value, urlOnlySettings), value);
  }
});

test("cleanup parses a URL only after finding a tracking parameter candidate", () => {
  const OriginalURL = globalThis.URL;
  let constructions = 0;
  class CountingURL extends OriginalURL {
    constructor(url: string | URL, base?: string | URL) {
      constructions += 1;
      super(url, base);
    }
  }
  Object.defineProperty(globalThis, "URL", {
    configurable: true,
    value: CountingURL
  });

  try {
    buildPrompt("https://example.com/path", urlOnlySettings);
    buildPrompt("https://example.com/path?keep=1#frag", urlOnlySettings);
    assert.equal(constructions, 0);

    buildPrompt("https://example.com/path?utm_source=x", urlOnlySettings);
    assert.equal(constructions, 1);
  } finally {
    Object.defineProperty(globalThis, "URL", {
      configurable: true,
      value: OriginalURL
    });
  }
});

test("tracking-parameter cleanup can be disabled", () => {
  const trackedUrl = "https://example.com/article?utm_source=newsletter&article=42#comments";

  assert.equal(
    buildPrompt(trackedUrl, { ...urlOnlySettings, stripTrackingParameters: false }),
    trackedUrl
  );
});

test("optional text can be prepended without creating a multiline prompt", () => {
  assert.equal(
    buildPrompt(pageUrl, { optionalText: "  Summarize this  ", placement: "prepend" }),
    `Summarize this ${pageUrl}`
  );
});

test("appended optional text is separated from the URL by two newlines", () => {
  const prompt = buildPrompt(pageUrl, {
    optionalText: " \nExplain the risks\n ",
    placement: "append"
  });
  const expected = `${pageUrl}\n\nExplain the risks`;
  assert.equal(prompt, expected);
  assert.equal(new URL(buildChatGPTUrl(prompt)).searchParams.get("prompt"), expected);
});

for (const placement of ["prepend", "append"] as const) {
  for (const newline of ["\n", "\r\n", "\r"]) {
    test(`optional text preserves paragraphs with ${JSON.stringify(newline)} (${placement})`, () => {
      const optionalText = `  Summarize.${newline}${newline}Assess evidence.${newline}  Keep indentation.  `;
      const text = "Summarize.\n\nAssess evidence.\n  Keep indentation.";
      const expected = placement === "prepend" ? `${text} ${pageUrl}` : `${pageUrl}\n\n${text}`;
      const prompt = buildPrompt(pageUrl, { optionalText, placement });

      assert.equal(prompt, expected);
      assert.equal(new URL(buildChatGPTUrl(prompt)).searchParams.get("prompt"), expected);
    });
  }
}

for (const placement of ["prepend", "append"] as const) {
  test(`empty or whitespace-only optional text produces only the URL (${placement})`, () => {
    for (const optionalText of ["", " \r\n\n\t "]) {
      assert.equal(buildPrompt(pageUrl, { optionalText, placement }), pageUrl);
    }
  });
}

test("missing or invalid persisted settings fall back safely", () => {
  assert.deepEqual(
    normalizeSettings({ optionalText: "Question", placement: "invalid" as "append" }),
    {
      optionalText: "Question",
      placement: "append",
      stripTrackingParameters: true,
      autoSubmit: true,
      autoClose: true
    }
  );
});

test("automatic closing defaults on only when absent and preserves explicit choices", () => {
  assert.equal(DEFAULT_SETTINGS.autoClose, true);
  for (const settings of [undefined, {}, { autoSubmit: false }]) {
    assert.equal(normalizeSettings(settings).autoClose, true);
  }
  for (const autoClose of [true, false]) {
    assert.equal(normalizeSettings({ autoClose }).autoClose, autoClose);
  }
  for (const invalid of [null, "true", "false", 0, 1]) {
    assert.equal(normalizeSettings({ autoClose: invalid as unknown as boolean }).autoClose, false);
  }
});

test("automatic submission and closing settings are restored", () => {
  assert.deepEqual(
    normalizeSettings({ autoSubmit: false, autoClose: true }),
    {
      optionalText: DEFAULT_SETTINGS.optionalText,
      placement: "append",
      stripTrackingParameters: true,
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

test("automatic closing uses narrow response-state markers", () => {
  assert.equal(
    ASSISTANT_MESSAGE_SELECTOR,
    'main [data-chatgpt-conversation-selection-target] ' +
      '[data-turn-key] ' +
      '[data-markdown-text-style="assistant-message"]'
  );
  assert.equal(
    RESPONSE_STOP_BUTTON_SELECTOR,
    'button[type="button"][aria-label="Stop"]'
  );
});

test("the manifest requests only the required extension permissions", () => {
  const manifest = JSON.parse(readFileSync("manifest.json", "utf8")) as {
    minimum_chrome_version?: string;
    permissions?: string[];
  };

  assert.equal(manifest.minimum_chrome_version, "120");
  assert.deepEqual(manifest.permissions, [
    "activeTab",
    "contextMenus",
    "scripting",
    "storage"
  ]);
});

test("the hovered-link command has a customizable cross-platform default", () => {
  const manifest = JSON.parse(readFileSync("manifest.json", "utf8")) as {
    commands?: Record<string, {
      description?: string;
      suggested_key?: { default?: string; mac?: string };
    }>;
  };

  assert.deepEqual(manifest.commands?.["send-hovered-link-to-chatgpt"], {
    description: "Send a hovered link or the current page to ChatGPT",
    suggested_key: {
      default: "Ctrl+B",
      mac: "Command+B"
    }
  });
});

test("the shortcut reads the resolved URL of the hovered link", () => {
  const originalDocument = globalThis.document;
  const links = [
    { href: "https://example.com/outer" },
    { href: "https://example.com/inner" }
  ];
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      querySelectorAll(selector: string) {
        if (selector === "a[href]:hover") {
          return links;
        }
        assert.equal(selector, ":hover");
        return [];
      }
    }
  });

  try {
    assert.equal(getShortcutTargetUrl(), "https://example.com/inner");
  } finally {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: originalDocument
    });
  }
});

test("the shortcut reads a hovered link inside an open shadow root", () => {
  const originalDocument = globalThis.document;
  const shadowRoot = {
    querySelectorAll(selector: string) {
      if (selector === "a[href]:hover") {
        return [{ href: "https://www.reddit.com/r/example/comments/post/comment/id/" }];
      }
      assert.equal(selector, ":hover");
      return [];
    }
  };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      querySelectorAll(selector: string) {
        if (selector === "a[href]:hover") {
          return [];
        }
        assert.equal(selector, ":hover");
        return [{ shadowRoot }];
      }
    }
  });

  try {
    assert.equal(
      getShortcutTargetUrl(),
      "https://www.reddit.com/r/example/comments/post/comment/id/"
    );
  } finally {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: originalDocument
    });
  }
});

test("the shortcut uses the current page URL when no link is hovered", () => {
  const originalDocument = globalThis.document;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      location: { href: pageUrl },
      querySelectorAll() {
        return [];
      }
    }
  });

  try {
    assert.equal(getShortcutTargetUrl(), pageUrl);
  } finally {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: originalDocument
    });
  }
});

test("Send uses the observed composer form's native submit control", () => {
  assert.deepEqual(SEND_BUTTON_SELECTORS, ['button[type="submit"]']);
});

function pendingDispatch(overrides: Partial<DispatchPayload> = {}): DispatchPayload {
  return {
    id: "dispatch-123",
    prompt: pageUrl,
    sourceTabId: 10,
    createdAt: 1_000,
    expiresAt: 16_000,
    status: "pending",
    autoSubmit: true,
    autoClose: false,
    ...overrides
  };
}

test("a dispatch can be claimed once only by its target tab", () => {
  const firstClaim = claimDispatch(pendingDispatch(), 20);
  assert.equal(firstClaim.ok, true);
  if (!firstClaim.ok) {
    return;
  }
  assert.equal(firstClaim.dispatch.status, "claimed");
  assert.equal(firstClaim.dispatch.targetTabId, 20);

  assert.deepEqual(claimDispatch(firstClaim.dispatch, 20), {
    ok: false,
    error: "Dispatch was already claimed."
  });
  assert.deepEqual(claimDispatch(pendingDispatch({ targetTabId: 21 }), 20), {
    ok: false,
    error: "Dispatch belongs to a different tab."
  });
});

test("expired dispatch cleanup ignores live dispatches and tab indexes", () => {
  const expired = pendingDispatch({ id: "expired", expiresAt: 2_000 });
  const live = pendingDispatch({ id: "live", expiresAt: 4_000 });
  assert.deepEqual(findExpiredDispatches({
    "dispatch:expired": expired,
    "dispatch:live": live,
    "tab-dispatch:20": "expired"
  }, 3_000), [expired]);
});

test("dispatch submission follows the one-way state machine", () => {
  assert.deepEqual(armDispatch(pendingDispatch(), 20), {
    ok: false,
    error: "Dispatch is not ready to submit."
  });

  const claimed = pendingDispatch({ status: "claimed", targetTabId: 20 });
  const armed = armDispatch(claimed, 20);
  assert.equal(armed.ok, true);
  if (!armed.ok) {
    return;
  }
  assert.equal(armed.dispatch.status, "submitting");
  assert.equal(canCompleteDispatch(armed.dispatch), true);
  assert.equal(canCompleteDispatch(claimed), false);
  assert.equal(
    canCompleteDispatch(pendingDispatch({ status: "claimed", autoSubmit: false })),
    true
  );
});

test("a temporarily missing composer does not confirm submission", () => {
  assert.equal(isSubmissionConfirmed({ composerPresent: false }), false);
  assert.equal(isSubmissionConfirmed({
    composerPresent: true,
    composerHasExpectedPrompt: false,
    sendButtonEnabled: true
  }), true);
  assert.equal(isSubmissionConfirmed({
    composerPresent: true,
    composerHasExpectedPrompt: true,
    sendButtonEnabled: false
  }), true);
});

test("unreadable composer text is not evidence that the expected prompt was cleared", () => {
  for (const sendButtonEnabled of [true, null]) {
    assert.equal(isSubmissionConfirmed({
      composerPresent: true,
      composerHasExpectedPrompt: null,
      sendButtonEnabled
    }), false);
  }
});

test("failure action titles are useful without exposing dispatch data", () => {
  const error = `Prompt injection failed for ${pageUrl}`;
  const title = getFailureActionTitle(error);
  assert.equal(title, "Share to ChatGPT: prompt verification failed");
  assert.equal(title.includes(pageUrl), false);
  assert.equal(
    getFailureActionTitle("Cannot access contents of the page"),
    "Share to ChatGPT: shortcut unavailable on this page"
  );
});

function optionsFields(): OptionsFields {
  return {
    optionalText: { value: "Summarize" },
    placement: { value: "append" },
    stripTrackingParameters: { checked: true },
    autoSubmit: { checked: true },
    autoClose: { checked: false, disabled: false },
    status: { textContent: "" }
  };
}

test("options storage failures are shown without exposing error details", async () => {
  const fields = optionsFields();
  fields.autoSubmit.checked = false;
  const storage: SettingsStorage = {
    async get() {
      throw new Error(`private detail: ${pageUrl}`);
    },
    async set() {
      throw new Error(`private detail: ${pageUrl}`);
    }
  };
  const reported: string[] = [];
  const reportError = (message: string): void => {
    reported.push(message);
  };

  assert.equal(await loadOptions(fields, storage, reportError), false);
  const loadStatus: string = fields.status.textContent;
  assert.equal(loadStatus, "Could not load settings.");
  assert.equal(loadStatus.includes(pageUrl), false);
  assert.equal(fields.autoClose.disabled, true);

  assert.equal(await saveOptions(fields, storage, () => 0, reportError), false);
  const saveStatus: string = fields.status.textContent;
  assert.equal(saveStatus, "Could not save settings.");
  assert.equal(saveStatus.includes(pageUrl), false);
  assert.deepEqual(reported, [
    "[Share to ChatGPT] Could not load settings.",
    "[Share to ChatGPT] Could not save settings."
  ]);
});

test("the manifest provides extension and toolbar icons", () => {
  const manifest = JSON.parse(readFileSync("manifest.json", "utf8")) as {
    icons?: Record<string, string>;
    action?: { default_icon?: Record<string, string> };
  };
  const expected = {
    "16": "icons/icon16.png",
    "32": "icons/icon32.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  };

  assert.deepEqual(manifest.icons, expected);
  assert.deepEqual(manifest.action?.default_icon, expected);
  for (const path of Object.values(expected)) {
    assert.equal(readFileSync(path).subarray(1, 4).toString(), "PNG");
  }
});
