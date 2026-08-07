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
  SEND_BUTTON_SELECTORS
} from "../src/selectors";
import { isSubmissionConfirmed } from "../src/submission";
import type { DispatchPayload } from "../src/types";

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

test("exact Send controls take priority over a generic submit button", () => {
  assert.deepEqual(SEND_BUTTON_SELECTORS, [
    'button[data-testid="send-button"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label="Send message"]',
    'button[type="submit"]'
  ]);
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
