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
type TabUpdatedListener = (
  tabId: number,
  changeInfo: chrome.tabs.TabChangeInfo,
  tab: chrome.tabs.Tab
) => void;
type TabRemovedListener = (
  tabId: number,
  removeInfo: chrome.tabs.TabRemoveInfo
) => void;

test("the background dispatch lifecycle binds, advances, and consumes state", async () => {
  const session = new Map<string, unknown>();
  const createdTabs: chrome.tabs.CreateProperties[] = [];
  const updatedTabs: Array<{
    tabId: number;
    properties: chrome.tabs.UpdateProperties;
    dispatchAtNavigation: DispatchPayload | undefined;
  }> = [];
  const badgeUpdates: chrome.action.BadgeTextDetails[] = [];
  const titleUpdates: chrome.action.TitleDetails[] = [];
  const scheduledTimers: Array<{ callback: () => void; delay?: number }> = [];
  const removedStorageKeys: string[] = [];
  let actionClickListener: ActionClickListener | undefined;
  let messageListener: MessageListener | undefined;
  let tabUpdatedListener: TabUpdatedListener | undefined;
  let tabRemovedListener: TabRemovedListener | undefined;
  let localSettings: Record<string, unknown> | undefined;
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
        removedStorageKeys.push(key);
        session.delete(key);
      }
    }
  };

  const fakeChrome = {
    storage: {
      session: storageArea,
      local: {
        async get(): Promise<Record<string, unknown>> {
          return localSettings ? { settings: localSettings } : {};
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
      async setTitle(details: chrome.action.TitleDetails): Promise<void> {
        titleUpdates.push(details);
      }
    },
    tabs: {
      async create(properties: chrome.tabs.CreateProperties): Promise<chrome.tabs.Tab> {
        createdTabs.push(properties);
        return { id: nextTabId++ } as chrome.tabs.Tab;
      },
      async update(
        tabId: number,
        properties: chrome.tabs.UpdateProperties
      ): Promise<chrome.tabs.Tab> {
        updatedTabs.push({
          tabId,
          properties,
          dispatchAtNavigation: dispatchEntries(session)[0]
        });
        return { id: tabId } as chrome.tabs.Tab;
      },
      async remove(): Promise<void> {},
      onUpdated: {
        addListener(listener: TabUpdatedListener): void {
          tabUpdatedListener = listener;
        }
      },
      onRemoved: {
        addListener(listener: TabRemovedListener): void {
          tabRemovedListener = listener;
        }
      }
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
    value: (callback: () => void, delay?: number) => {
      scheduledTimers.push({ callback, delay });
      return 0;
    }
  });

  try {
    await import("../src/background");
    assert.ok(actionClickListener);
    assert.ok(messageListener);
    assert.ok(tabUpdatedListener);
    assert.ok(tabRemovedListener);

    actionClickListener({
      id: 10,
      url: "https://example.com/article?utm_source=newsletter&item=42#details"
    } as chrome.tabs.Tab);
    await waitUntil(() => updatedTabs.length === 1);

    assert.deepEqual(createdTabs[0], { url: "about:blank", active: false });
    assert.equal(updatedTabs[0]?.tabId, 20);
    assert.match(
      updatedTabs[0]?.properties.url as string,
      /^https:\/\/chatgpt\.com\/\?prompt=/
    );
    assert.equal(updatedTabs[0]?.dispatchAtNavigation?.targetTabId, 20);
    assert.equal(updatedTabs[0]?.dispatchAtNavigation?.status, "pending");
    assert.equal(
      updatedTabs[0]?.dispatchAtNavigation?.prompt,
      "https://example.com/article?item=42#details"
    );

    const pending = dispatchEntries(session)[0];
    assert.ok(pending);
    assert.equal(pending.status, "pending");
    assert.equal(pending.sourceTabId, 10);
    assert.equal(pending.targetTabId, 20);
    assert.equal(lastBadgeText(badgeUpdates, 10), "…");
    assert.equal(
      lastActionTitle(titleUpdates, 10),
      "Share to ChatGPT: dispatch in progress"
    );

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
    assert.equal(lastBadgeText(badgeUpdates, 10), "✓");
    assert.equal(
      lastActionTitle(titleUpdates, 10),
      "Share to ChatGPT: prompt submitted"
    );

    const successClear = scheduledTimers.find((timer) => timer.delay === 2_000);
    assert.ok(successClear);
    successClear.callback();
    await waitUntil(() => lastBadgeText(badgeUpdates, 10) === "");
    assert.equal(lastActionTitle(titleUpdates, 10), "Send this page to ChatGPT");

    actionClickListener({ id: 30, url: "https://example.com/first" } as chrome.tabs.Tab);
    actionClickListener({ id: 30, url: "https://example.com/second" } as chrome.tabs.Tab);
    await waitUntil(() => updatedTabs.length === 3 && dispatchEntries(session).length === 2);

    const olderDispatch = dispatchEntries(session).find((entry) => entry.targetTabId === 21);
    const latestDispatch = dispatchEntries(session).find((entry) => entry.targetTabId === 22);
    assert.ok(olderDispatch);
    assert.ok(latestDispatch);
    assert.equal(lastBadgeText(badgeUpdates, 30), "…");

    assert.deepEqual(await sendContentMessage(
      messageListener,
      {
        type: "fail-dispatch",
        dispatchId: olderDispatch.id,
        error: "Older dispatch failed."
      },
      21
    ), { ok: true });
    assert.equal(lastBadgeText(badgeUpdates, 30), "…");
    assert.equal(lastBadgeText(badgeUpdates, 21), "!");

    assert.deepEqual(await sendContentMessage(
      messageListener,
      {
        type: "fail-dispatch",
        dispatchId: latestDispatch.id,
        error: "Latest dispatch failed."
      },
      22
    ), { ok: true });
    assert.equal(lastBadgeText(badgeUpdates, 30), "!");

    tabUpdatedListener(30, { status: "loading" }, { id: 30 } as chrome.tabs.Tab);
    await waitUntil(() => lastBadgeText(badgeUpdates, 30) === "");
    assert.equal(lastActionTitle(titleUpdates, 30), "Send this page to ChatGPT");

    localSettings = { stripTrackingParameters: false };
    const unchangedUrl =
      "https://example.com/article?utm_source=newsletter&item=42#details";
    actionClickListener({ id: 40, url: unchangedUrl } as chrome.tabs.Tab);
    await waitUntil(() => updatedTabs.length === 4);
    assert.equal(updatedTabs[3]?.dispatchAtNavigation?.prompt, unchangedUrl);

    actionClickListener({ id: 50, url: "https://example.com/closed-target" } as chrome.tabs.Tab);
    await waitUntil(() => updatedTabs.length === 5);
    const closedTargetDispatch = dispatchEntries(session).find(
      (entry) => entry.sourceTabId === 50
    );
    assert.ok(closedTargetDispatch?.targetTabId);
    assert.equal(lastBadgeText(badgeUpdates, 50), "…");

    tabRemovedListener(closedTargetDispatch.targetTabId, {
      isWindowClosing: false,
      windowId: 1
    });
    await waitUntil(() =>
      !session.has(`dispatch:${closedTargetDispatch.id}`) &&
      !session.has("source-status:50") &&
      lastBadgeText(badgeUpdates, 50) === "" &&
      removedStorageKeys.includes(`source-status:${closedTargetDispatch.targetTabId}`)
    );
    await Promise.resolve();
    assert.equal(lastActionTitle(titleUpdates, 50), "Send this page to ChatGPT");
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

function lastBadgeText(
  updates: chrome.action.BadgeTextDetails[],
  tabId: number
): string | undefined {
  return updates.filter((update) => update.tabId === tabId).at(-1)?.text;
}

function lastActionTitle(
  updates: chrome.action.TitleDetails[],
  tabId: number
): string | undefined {
  return updates.filter((update) => update.tabId === tabId).at(-1)?.title;
}

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
