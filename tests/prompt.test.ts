import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getShortcutTargetUrl } from "../src/hovered-link";
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
