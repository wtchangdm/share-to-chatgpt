import assert from "node:assert/strict";
import test from "node:test";
import type {
  ContentMessage,
  DispatchPayload,
  DispatchResponse
} from "../src/types";

type ActionClickListener = (tab: chrome.tabs.Tab) => void;
type MessageListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: DispatchResponse) => void
) => boolean | undefined;

test("the background dispatch lifecycle binds, advances, and consumes state", async () => {
  const session = new Map<string, unknown>();
  const createdTabs: chrome.tabs.CreateProperties[] = [];
  const badgeUpdates: chrome.action.BadgeTextDetails[] = [];
  let actionClickListener: ActionClickListener | undefined;
  let messageListener: MessageListener | undefined;
  let nextTabId = 20;

  const storageArea = {
    async get(keys?: string | string[] | null): Promise<Record<string, unknown>> {
      if (keys === null || keys === undefined) {
        return Object.fromEntries(session);
      }
      const requestedKeys = typeof keys === "string" ? [keys] : keys;
      return Object.fromEntries(requestedKeys.flatMap((key) =>
        session.has(key) ? [[key, session.get(key)]] : []
      ));
    },
    async set(items: Record<string, unknown>): Promise<void> {
      for (const [key, value] of Object.entries(items)) {
        session.set(key, value);
      }
    },
    async remove(keys: string | string[]): Promise<void> {
      for (const key of typeof keys === "string" ? [keys] : keys) {
        session.delete(key);
      }
    }
  };

  const fakeChrome = {
    storage: {
      session: storageArea,
      local: {
        async get(): Promise<Record<string, unknown>> {
          return {};
        }
      }
    },
    action: {
      onClicked: {
        addListener(listener: ActionClickListener): void {
          actionClickListener = listener;
        }
      },
      async setBadgeBackgroundColor(): Promise<void> {},
      async setBadgeText(details: chrome.action.BadgeTextDetails): Promise<void> {
        badgeUpdates.push(details);
      },
      async setTitle(): Promise<void> {}
    },
    tabs: {
      async create(properties: chrome.tabs.CreateProperties): Promise<chrome.tabs.Tab> {
        createdTabs.push(properties);
        return { id: nextTabId++ } as chrome.tabs.Tab;
      },
      async remove(): Promise<void> {},
      onRemoved: { addListener(): void {} }
    },
    scripting: { async executeScript(): Promise<never[]> { return []; } },
    contextMenus: {
      async removeAll(): Promise<void> {},
      create(): void {},
      onClicked: { addListener(): void {} }
    },
    commands: { onCommand: { addListener(): void {} } },
    runtime: {
      onInstalled: { addListener(): void {} },
      onMessage: {
        addListener(listener: MessageListener): void {
          messageListener = listener;
        }
      }
    }
  } as unknown as typeof chrome;

  const originalChrome = globalThis.chrome;
  const originalSetTimeout = globalThis.setTimeout;
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: fakeChrome
  });
  Object.defineProperty(globalThis, "setTimeout", {
    configurable: true,
    value: () => 0
  });

  try {
    await import("../src/background");
    assert.ok(actionClickListener);
    assert.ok(messageListener);

    actionClickListener({
      id: 10,
      url: "https://example.com/article"
    } as chrome.tabs.Tab);
    await waitUntil(() =>
      createdTabs.length === 1 && dispatchEntries(session)[0]?.targetTabId === 20
    );

    assert.equal(createdTabs[0]?.active, false);
    assert.match(createdTabs[0]?.url as string, /^https:\/\/chatgpt\.com\/\?prompt=/);

    const pending = dispatchEntries(session)[0];
    assert.ok(pending);
    assert.equal(pending.status, "pending");
    assert.equal(pending.sourceTabId, 10);
    assert.equal(pending.targetTabId, 20);

    const wrongTabClaim = await sendContentMessage(
      messageListener,
      { type: "claim-dispatch", dispatchId: pending.id },
      21
    );
    assert.deepEqual(wrongTabClaim, {
      ok: false,
      error: "Dispatch belongs to a different tab."
    });

    const claim = await sendContentMessage(
      messageListener,
      { type: "claim-dispatch", dispatchId: pending.id },
      20
    );
    assert.equal(claim.ok, true);
    if (!claim.ok || !claim.dispatch) {
      return;
    }
    assert.equal(claim.dispatch.status, "claimed");

    const duplicateClaim = await sendContentMessage(
      messageListener,
      { type: "claim-dispatch", dispatchId: pending.id },
      20
    );
    assert.deepEqual(duplicateClaim, {
      ok: false,
      error: "Dispatch was already claimed."
    });

    assert.deepEqual(await sendContentMessage(
      messageListener,
      { type: "arm-dispatch", dispatchId: pending.id },
      20
    ), { ok: true });
    assert.equal(dispatchEntries(session)[0]?.status, "submitting");

    assert.deepEqual(await sendContentMessage(
      messageListener,
      { type: "complete-dispatch", dispatchId: pending.id, closeTab: false },
      20
    ), { ok: true });
    assert.equal(dispatchEntries(session).length, 0);
    assert.equal(session.has("tab-dispatch:20"), false);
    assert.ok(badgeUpdates.some((update) => update.tabId === 10 && update.text === ""));
  } finally {
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: originalChrome
    });
    Object.defineProperty(globalThis, "setTimeout", {
      configurable: true,
      value: originalSetTimeout
    });
  }
});

function dispatchEntries(session: Map<string, unknown>): DispatchPayload[] {
  return Array.from(session.entries())
    .filter(([key]) => key.startsWith("dispatch:"))
    .map(([, value]) => value as DispatchPayload);
}

async function sendContentMessage(
  listener: MessageListener,
  message: ContentMessage,
  tabId: number
): Promise<DispatchResponse> {
  return await new Promise((resolve, reject) => {
    const keepChannelOpen = listener(message, {
      url: "https://chatgpt.com/",
      tab: { id: tabId } as chrome.tabs.Tab
    }, resolve);
    if (keepChannelOpen !== true) {
      reject(new Error("The background listener did not keep the response channel open."));
    }
  });
}

async function waitUntil(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error("Timed out waiting for background work.");
}
