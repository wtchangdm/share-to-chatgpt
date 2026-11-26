import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { DEFAULT_SETTINGS } from "../src/prompt";
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

test("the background dispatch lifecycle binds, advances, and consumes state", async (t) => {
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
  let scans = 0;
  let injections = 0;
  let injectImmediately: boolean | undefined;
  let inject = async (): Promise<string> => "https://example.com/hovered";
  const shortcuts = workerEvent<(command: string, tab: chrome.tabs.Tab) => void>();
  const menus = workerEvent<(info: chrome.contextMenus.OnClickData, tab: chrome.tabs.Tab) => void>();
  let settingsFailure = false;
  let failWritePrefix: string | undefined;
  const activations = workerEvent<(info: { tabId: number; windowId: number }) => void>();
  const sessionChanges = workerEvent<(changes: Record<string, chrome.storage.StorageChange>) => void>();
  const visit = (id: number) => { for (const tabId of [id, 9999]) activations.listener?.({ tabId, windowId: 1 }); };
  let storageCalls = 0;
  const activeTabs = new Set<number>();
  let currentLocation: Pick<chrome.tabs.Tab, "status" | "url" | "pendingUrl"> = {
    status: "complete", url: "https://chatgpt.com/"
  };
  const closedTabs: number[] = [];
  function seed(id: string, targetTabId: number, status: DispatchPayload["status"], expired = false): DispatchPayload {
    const dispatch: DispatchPayload = {
      id, targetTabId, sourceTabId: targetTabId + 1000, status,
      prompt: "https://example.com/test", autoClose: true, autoSubmit: true,
      createdAt: Date.now() - 15_000, expiresAt: Date.now() + (expired ? -1 : 15_000)
    };
    session.set(`dispatch:${id}`, dispatch);
    session.set(`tab-dispatch:${targetTabId}`, id);
    session.set(`source-status:${dispatch.sourceTabId}`, id);
    sessionChanges.listener?.({ [`tab-dispatch:${targetTabId}`]: { newValue: id } });
    return dispatch;
  }
  const waking = seed("worker-waking", 700, "confirmed");
  const visited = seed("persisted-visit", 701, "pending");
  session.set("target-activated:persisted-visit", true);
  const startup = seed("worker-startup-expiry", 100, "confirmed", true);
  seed("interrupted-veto-cleanup", 702, "confirmed");
  session.delete("tab-dispatch:702");

  const recovered = seed("recovered-live", 850, "confirmed");
  const unbound = seed("unbound-live", 851, "pending");
  delete unbound.targetTabId;
  session.delete("tab-dispatch:851");
  const bad = seed("lost-target", 852, "pending");
  session.set("tab-dispatch:852", recovered.id); // Wrong tab for an otherwise valid payload.
  session.set("tab-dispatch:853", "missing-payload");
  session.set("target-activated:missing-payload", true);
  session.set("target-activated:no-index-or-payload", true);
  session.set("tab-dispatch:854", "concurrent-bind");
  session.set("tab-dispatch:855", "orphan-before-reassignment");
  const reassigned = seed("previous-owner", 856, "confirmed");
  const newOwner = seed("current-owner", 856, "confirmed");
  session.set("unrelated:missing-payload", true);

  type ReadKeys = string | string[] | null | undefined;
  let hooks: {
    beforeRead?: (keys: ReadKeys) => void | Promise<void>;
    afterRead?: (keys: ReadKeys) => void | Promise<void>;
    beforeWrite?: (items: Record<string, unknown>) => void | Promise<void>;
    beforeCreate?: () => void;
    beforeRemove?: (keys: string | string[]) => void;
    afterRemove?: (keys: string | string[]) => void;
    beforeTabGet?: () => void;
    afterTabGet?: (id: number) => void;
  } = {};
  t.afterEach(() => { hooks = {}; });
  let releaseOrphanVisit: (() => void) | undefined;
  const storageArea = {
    onChanged: sessionChanges,
    async get(keys?: string | string[] | null): Promise<Record<string, unknown>> {
      const wait = hooks.beforeRead?.(keys);
      if (wait) await wait;
      storageCalls++;
      if (keys === null || keys === undefined) {
        if (++scans === 1) visit(700); // Wake-up before the recovery snapshot resolves.
        const snapshot = structuredClone(Object.fromEntries(session));
        if (scans === 1) {
          seed("concurrent-bind", 854, "claimed");
          seed("replacement", 855, "pending");
          sessionChanges.listener?.({ "tab-dispatch:853": { newValue: "missing-payload" } });
          visit(853);
        }
        return snapshot;
      }
      const requestedKeys = typeof keys === "string" ? [keys] : keys;
      const snapshot = Object.fromEntries(requestedKeys.flatMap((key) =>
        session.has(key) ? [[key, structuredClone(session.get(key))]] : []
      ));
      const reply = hooks.afterRead?.(keys);
      if (reply) await reply;
      return snapshot;
    },
    async set(items: Record<string, unknown>): Promise<void> {
      const wait = hooks.beforeWrite?.(items);
      if (wait) await wait;
      storageCalls++;
      if ("target-activated:missing-payload" in items) await new Promise<void>(done => { releaseOrphanVisit = done; });
      const prefix = failWritePrefix;
      if (prefix && Object.keys(items).some(key => key.startsWith(prefix))) {
        failWritePrefix = undefined;
        throw new Error("Session write failed.");
      }
      const changes: Record<string, chrome.storage.StorageChange> = {};
      for (const [key, value] of Object.entries(items)) {
        changes[key] = { oldValue: session.get(key), newValue: structuredClone(value) };
        session.set(key, structuredClone(value));
      }
      sessionChanges.listener?.(changes);
    },
    async remove(keys: string | string[]): Promise<void> {
      hooks.beforeRemove?.(keys);
      storageCalls++;
      const changes: Record<string, chrome.storage.StorageChange> = {};
      for (const key of typeof keys === "string" ? [keys] : keys) {
        if (session.has(key)) changes[key] = { oldValue: session.get(key) };
        removedStorageKeys.push(key);
        session.delete(key);
      }
      sessionChanges.listener?.(changes);
      if (hooks.afterRemove) { await Promise.resolve(); hooks.afterRemove(keys); }
    }
  };

  const fakeChrome = {
    storage: {
      session: storageArea,
      local: {
        async get(): Promise<Record<string, unknown>> {
          if (settingsFailure) throw new Error("Settings unavailable.");
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
        hooks.beforeCreate?.();
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
          dispatchAtNavigation: dispatchEntries(session).find(
            (dispatch) => dispatch.targetTabId === tabId
          )
        });
        return { id: tabId } as chrome.tabs.Tab;
      },
      async get(tabId: number): Promise<chrome.tabs.Tab> {
        hooks.beforeTabGet?.();
        await Promise.resolve(); // Navigation can change the tab before Chrome replies.
        const tab = { id: tabId, active: activeTabs.has(tabId), ...currentLocation } as chrome.tabs.Tab;
        if (hooks.afterTabGet) { await Promise.resolve(); hooks.afterTabGet(tabId); }
        return tab;
      },
      async remove(tabId: number): Promise<void> { closedTabs.push(tabId); },
      onActivated: activations,
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
    scripting: { async executeScript(options: { injectImmediately?: boolean }) {
      injections++;
      injectImmediately = options.injectImmediately;
      return [{ result: await inject() }];
    } },
    contextMenus: {
      async removeAll(): Promise<void> {},
      create(): void {},
      onClicked: menus
    },
    commands: { onCommand: shortcuts },
    runtime: {
      onInstalled: { addListener(): void {} },
      onMessage: {
        addListener(listener: MessageListener): void {
          messageListener = listener;
        }
      }
    }
  } as unknown as typeof chrome;

  const send = (message: ContentMessage, tabId: number, url?: string, active?: boolean) =>
    sendContentMessage(messageListener!, message, tabId, url, active);
  const transition = (d: DispatchPayload, type: "claim-dispatch" | "arm-dispatch" | "confirm-dispatch", tabId = d.targetTabId!) =>
    send({ type, dispatchId: d.id }, tabId);
  const complete = (d: DispatchPayload, closeTab: boolean, closePath?: string, senderUrl?: string) =>
    send(closeTab || closePath !== undefined
      ? { type: "complete-dispatch", dispatchId: d.id, closeTab, closePath }
      : { type: "complete-dispatch", dispatchId: d.id, closeTab }, d.targetTabId!, senderUrl);
  const fail = (d: DispatchPayload, error: string, tabId = d.targetTabId!) =>
    send({ type: "fail-dispatch", dispatchId: d.id, error }, tabId);
  const badge = (tabId: number) => lastBadgeText(badgeUpdates, tabId);
  const title = (tabId: number) => lastActionTitle(titleUpdates, tabId);
  const sharePage = (id: number, path?: string) =>
    actionClickListener!((path === undefined ? { id } : { id, url: `https://example.com/${path}` }) as chrome.tabs.Tab);
  const navigate = (id: number, info: chrome.tabs.TabChangeInfo = { status: "loading" }) =>
    tabUpdatedListener!(id, info, { id } as chrome.tabs.Tab);
  const lastNavigation = () => updatedTabs.at(-1)?.dispatchAtNavigation;
  async function navigationFrom(source: number) {
    await waitUntil(() => lastNavigation()?.sourceTabId === source);
    return lastNavigation()!;
  }
  function deferredCloses() {
    const start = scheduledTimers.length;
    return () => {
      for (const timer of scheduledTimers.slice(start)) if (timer.delay === 0) timer.callback();
      return tick();
    };
  }

  function failReads(match: (keys: ReadKeys) => boolean, limit = Infinity) {
    const before = hooks.beforeRead;
    let attempts = 0;
    hooks.beforeRead = keys => {
      if (match(keys) && ++attempts <= limit) throw new Error("Session read failed.");
      return before?.(keys);
    };
    return () => attempts;
  }
  function pauseWrite(key: string, rejectPrefix?: string) {
    const blocked = gate();
    let entered = false;
    hooks.beforeWrite = items => {
      if (rejectPrefix && Object.keys(items).some(k => k.startsWith(rejectPrefix))) throw new Error("Session write failed.");
      if (key in items) { entered = true; return blocked.wait; }
    };
    return {
      waitUntilBlocked: () => waitUntil(() => entered),
      release() { assert.ok(entered, `No write reached ${key}`); blocked.release(); }
    };
  }
  async function nextShare(id: number, path: string) {
    const target = nextTabId;
    sharePage(id, path);
    await waitUntil(() => updatedTabs.at(-1)?.tabId === target);
    const dispatch = lastNavigation();
    assert.equal(dispatch?.targetTabId, target);
    return dispatch!;
  }
  // Chrome's deferred tabs.get can resolve with newer state than the sender reported.
  async function closeResult(d: DispatchPayload, proof: string | undefined, senderUrl?: string, lookup?: typeof currentLocation) {
    const flush = deferredCloses();
    assert.deepEqual(await complete(d, true, proof, senderUrl), { ok: true });
    assert.equal(session.has(`dispatch:${d.id}`), false);
    const settled = flush();
    if (lookup) currentLocation = lookup;
    await settled;
    assert.equal(badge(d.sourceTabId!), "✓");
    return closedTabs.includes(d.targetTabId!);
  }
  async function assertNoStorage(work: () => void, message?: string) {
    const before = storageCalls;
    work();
    await tick();
    assert.equal(storageCalls, before, message);
  }
  const unrelatedVisits = () => { for (let id = 9100; id < 9120; id++) visit(id); };
  const dropPayloads = (...ids: string[]) => { for (const id of ids) session.delete(`dispatch:${id}`); };
  const assertAbsent = (...keys: string[]) => { for (const key of keys) assert.equal(session.has(key), false, key); };
  async function restartTimers() {
    const start = scheduledTimers.length;
    await restartWorker();
    await tick();
    return scheduledTimers.slice(start);
  }
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

    await waitUntil(() => !session.has(`dispatch:${startup.id}`));
    await t.test("startup consumes a confirmed timeout as submitted", async () => {
      await waitUntil(() => badge(1100) === "✓");
      assert.equal(badge(100), undefined);
      assert.equal(session.has("tab-dispatch:100"), false);
      assert.equal(closedTabs.length, 0);
    });
    await t.test("startup finishes interrupted cleanup of a revoked confirmed binding", async () => {
      await waitUntil(() => !session.has("dispatch:interrupted-veto-cleanup"));
      assert.equal(badge(1702), "✓");
      assert.equal(badge(702), undefined);
    });
    await t.test("startup reconciles orphan metadata without breaking valid or concurrently completed bindings", async (st) => {
      st.after(() => dropPayloads(bad.id, reassigned.id, newOwner.id, "concurrent-bind", "replacement"));
      await tick();
      assert.ok(releaseOrphanVisit);
      releaseOrphanVisit();
      await tick();
      assertAbsent(`dispatch:${bad.id}`, `dispatch:${reassigned.id}`, "tab-dispatch:852", "tab-dispatch:853",
        "target-activated:missing-payload", "target-activated:no-index-or-payload");
      assert.equal(session.get("tab-dispatch:856"), newOwner.id);
      assert.equal(session.get("tab-dispatch:854"), "concurrent-bind");
      assert.equal(session.get("tab-dispatch:855"), "replacement");
      assert.equal(session.get("tab-dispatch:850"), recovered.id);
      assert.equal(session.has("unrelated:missing-payload"), true);
      await assertNoStorage(() => visit(853), "the orphan watch must not survive");
    });
    await t.test("startup re-arms live confirmed and unbound pending deadlines", async (st) => {
      st.after(() => dropPayloads(recovered.id, unbound.id));
      for (const d of [recovered, unbound]) session.set(`dispatch:${d.id}`, { ...d, expiresAt: Date.now() });
      scheduledTimers.filter(timer => (timer.delay ?? 0) > 2000).forEach(timer => timer.callback());
      await tick();
      assertAbsent(`dispatch:${unbound.id}`, `dispatch:${recovered.id}`);
      assert.equal(badge(recovered.sourceTabId!), "✓");
      assert.equal(badge(unbound.sourceTabId!), "!");
    });
    await t.test("a removal event for a stale index cannot consume another tab's live dispatch", async (st) => {
      const valid = seed("correct-removal-owner", 880, "confirmed");
      session.set("tab-dispatch:881", valid.id);
      tabRemovedListener!(881, { isWindowClosing: false, windowId: 1 });
      await tick();
      st.after(() => { dropPayloads(valid.id); session.delete("tab-dispatch:880"); });
      assertAbsent("tab-dispatch:881");
      assert.equal(session.has(`dispatch:${valid.id}`), true);
      assert.equal(session.get("tab-dispatch:880"), valid.id);
    });
    await t.test("a prior worker's persisted activation prevents a fresh claim", async () => {
      assert.equal((await transition(visited, "claim-dispatch")).ok, false);
      assert.equal(session.has("dispatch:persisted-visit"), false);
    });
    await t.test("activation that wakes a restarted worker blocks deferred close", async () => {
      assert.equal(await closeResult(waking, "/"), false);
    });
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
      `https://example.com/article?item=42#details\n\n${DEFAULT_SETTINGS.optionalText}`
    );

    const pending = dispatchEntries(session)[0];
    assert.ok(pending);
    assert.equal(pending.status, "pending");
    assert.equal(pending.autoClose, true);
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

    const concurrentClaims = await Promise.all([
      sendContentMessage(
        messageListener,
        { type: "claim-dispatch", dispatchId: pending.id },
        20
      ),
      sendContentMessage(
        messageListener,
        { type: "claim-dispatch", dispatchId: pending.id },
        20
      )
    ]);
    assert.equal(concurrentClaims.filter((response) => response.ok).length, 1);
    assert.equal(concurrentClaims.filter((response) => !response.ok).length, 1);
    const claim = concurrentClaims.find((response) => response.ok);
    if (!claim?.ok || !claim.dispatch) {
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

    const concurrentArms = await Promise.all([
      sendContentMessage(
        messageListener,
        { type: "arm-dispatch", dispatchId: pending.id },
        20
      ),
      sendContentMessage(
        messageListener,
        { type: "arm-dispatch", dispatchId: pending.id },
        20
      )
    ]);
    assert.equal(concurrentArms.filter((response) => response.ok).length, 1);
    assert.equal(concurrentArms.filter((response) => !response.ok).length, 1);
    const armed = concurrentArms.find((response) => response.ok);
    if (!armed?.ok || !armed.dispatch) {
      assert.fail("The successful arm response did not include its dispatch.");
    }
    assert.equal(armed.dispatch.status, "submitting");
    assert.ok(armed.dispatch.expiresAt - pending.expiresAt > 90_000);
    assert.equal(dispatchEntries(session)[0]?.expiresAt, armed.dispatch.expiresAt);

    await t.test("auto-close requires one bound confirmation before completion", async () => {
      for (const closeTab of [false, true]) {
        const premature = seed(`premature-${closeTab}`, 111, "submitting");
        assert.equal((await complete(premature, closeTab, "/")).ok, false);
        await fail(premature, "unconfirmed");
      }
      assert.equal((await transition(pending, "confirm-dispatch", 21)).ok, false);
      assert.equal((await transition(pending, "confirm-dispatch")).ok, true);
      assert.equal((session.get(`dispatch:${pending.id}`) as DispatchPayload).status, "confirmed");
      assert.equal((await transition(pending, "confirm-dispatch")).ok, false);
      assert.equal((await transition(pending, "arm-dispatch")).ok, false);
    });
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

    const successClear = [...scheduledTimers].reverse().find((timer) => timer.delay === 2_000);
    assert.ok(successClear);
    successClear.callback();
    await waitUntil(() => lastBadgeText(badgeUpdates, 10) === "");
    assert.equal(lastActionTitle(titleUpdates, 10), "Send this page to ChatGPT");

    const rateTimerCount = (): number => scheduledTimers.filter((timer) =>
      timer.delay !== undefined && timer.delay > 0 && timer.delay <= 1_000
    ).length;
    const rateTimersBeforeRapidDispatches = rateTimerCount();
    actionClickListener({ id: 30, url: "https://example.com/first" } as chrome.tabs.Tab);
    actionClickListener({ id: 30, url: "https://example.com/second" } as chrome.tabs.Tab);
    await waitUntil(() => updatedTabs.length === 3 && dispatchEntries(session).length === 2);
    assert.equal(rateTimerCount(), rateTimersBeforeRapidDispatches);

    const olderDispatch = dispatchEntries(session).find((entry) => entry.targetTabId === 21);
    const latestDispatch = dispatchEntries(session).find((entry) => entry.targetTabId === 22);
    assert.ok(olderDispatch);
    assert.ok(latestDispatch);
    assert.equal(lastBadgeText(badgeUpdates, 30), "…");

    assert.equal((await Promise.all([
      sendContentMessage(
        messageListener,
        { type: "claim-dispatch", dispatchId: olderDispatch.id },
        21
      ),
      sendContentMessage(
        messageListener,
        { type: "claim-dispatch", dispatchId: latestDispatch.id },
        22
      )
    ])).every((response) => response.ok), true);
    const rateTimersBeforeArming = rateTimerCount();
    assert.equal((await Promise.all([
      sendContentMessage(
        messageListener,
        { type: "arm-dispatch", dispatchId: olderDispatch.id },
        21
      ),
      sendContentMessage(
        messageListener,
        { type: "arm-dispatch", dispatchId: latestDispatch.id },
        22
      )
    ])).every((response) => response.ok), true);
    assert.equal(rateTimerCount(), rateTimersBeforeArming);

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

    localSettings = { optionalText: "", stripTrackingParameters: false };
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

    const shareShortcut = (id: number) => shortcuts.listener!("send-hovered-link-to-chatgpt", { id } as chrome.tabs.Tab);
    await t.test("shortcut injection is synchronous, and successful sharing sweeps exactly once", async () => {
      const deadlines = () => scheduledTimers.filter(timer => (timer.delay ?? 0) > 2000).length;
      const before = { injections, scans, deadlines: deadlines() };
      shareShortcut(60);
      const synchronousInjections = injections - before.injections;
      await navigationFrom(60);
      assert.equal(synchronousInjections, 1);
      assert.equal(injectImmediately, true, "do not wait for document idle to sample hover");
      assert.equal(scans - before.scans, 1);
      assert.equal(deadlines() - before.deadlines, 1, "ordinary sweeps must not re-arm older dispatches");
    });
    for (const result of ["failure", "success"] as const) {
      await t.test(`late shortcut ${result} does not reclaim newer context-menu ownership`, async () => {
        let release!: () => void;
        inject = () => new Promise<string>((resolve, reject) => {
          release = () => result === "failure" ? reject(new Error("Cannot access page")) : resolve("https://example.com/late");
        });
        shareShortcut(61);
        await waitUntil(() => Boolean(release));
        const start = updatedTabs.length;
        menus.listener!({ menuItemId: "send-link-to-chatgpt", linkUrl: "https://example.com/newer" } as chrome.contextMenus.OnClickData, { id: 61 } as chrome.tabs.Tab);
        await waitUntil(() => updatedTabs.length > start && lastNavigation()?.prompt === "https://example.com/newer");
        const owner = session.get("source-status:61");
        release();
        await tick();
        assert.equal(session.get("source-status:61"), owner);
        assert.equal(badge(61), "…");
        if (result === "success") assert.equal(lastNavigation()?.prompt, "https://example.com/late");
      });
    }
    await t.test("source navigation invalidates an in-flight shortcut before its URL resolves", async () => {
      let resolve!: (url: string) => void;
      inject = () => new Promise<string>(done => { resolve = done; });
      shareShortcut(62);
      navigate(62);
      await waitUntil(() => Boolean(resolve));
      resolve("https://example.com/after-navigation");
      await navigationFrom(62);
      assert.equal(session.has("source-status:62"), false);
      assert.equal(badge(62), "");
    });
    await t.test("a toolbar invocation with no URL owns its failure", async () => {
      sharePage(63, "older");
      sharePage(63);
      const older = await navigationFrom(63);
      await waitUntil(() => badge(63) === "!");
      assert.notEqual(session.get("source-status:63"), older.id);
    });
    await t.test("settings failure is handled before dispatch allocation", async (st) => {
      const count = createdTabs.length;
      settingsFailure = true;
      st.after(() => { settingsFailure = false; });
      sharePage(64, "failure");
      await tick();
      assert.equal(badge(64), "!");
      assert.equal(createdTabs.length, count);
      assert.equal(dispatchEntries(session).some(record => record.sourceTabId === 64), false);
    });
    for (const prefix of ["source-status:", "dispatch:", "tab-dispatch:"]) {
      await t.test(`a failed ${prefix} write aborts navigation and leaves a clearable failure`, async () => {
        const navigations = updatedTabs.length;
        failWritePrefix = prefix;
        sharePage(65, "storage");
        await tick();
        assert.equal(failWritePrefix, undefined);
        assert.equal(updatedTabs.length, navigations);
        assert.equal(dispatchEntries(session).some(d => d.sourceTabId === 65), false);
        assert.equal(badge(65), "!");
        navigate(65);
        await waitUntil(() => badge(65) === "");
      });
    }
    await t.test("the latest restricted shortcut keeps its failure when an older dispatch completes", async () => {
      localSettings = { autoSubmit: false };
      sharePage(66, "older");
      const d = await navigationFrom(66);
      assert.ok(d?.targetTabId);
      inject = async () => { throw new Error("Cannot access contents of the page"); };
      shareShortcut(66);
      await waitUntil(() => badge(66) === "!");
      assert.equal((await transition(d, "claim-dispatch")).ok, true);
      assert.equal((await complete(d, false)).ok, true);
      assert.equal(badge(66), "!");
      assert.equal(title(66), "Share to ChatGPT: shortcut unavailable on this page");
    });
    await t.test("wrong and unbound senders cannot consume even expired dispatches", async () => {
      for (const targetTabId of [200, undefined]) {
        const d = seed("late", 200, "confirmed", true);
        d.targetTabId = targetTabId;
        const wrong = await fail(d, "late", 201);
        assert.equal(wrong.ok, false);
        assert.equal(session.has("dispatch:late"), true);
      }
      const d = seed("late", 200, "confirmed", true);
      assert.deepEqual(await complete(d, true, "/"), { ok: true });
      assert.equal(session.has("dispatch:late"), false);
      assert.equal(badge(1200), "✓");
      assert.equal(badge(200), undefined);
    });
    await t.test("late failure after confirmation consumes without a red badge", async () => {
      const d = seed("late-fail", 202, "confirmed");
      assert.equal((await fail(d, "observer failed")).ok, true);
      assert.equal(session.has(`dispatch:${d.id}`), false);
      assert.equal(badge(1202), "✓");
      assert.equal(badge(202), undefined);
    });
    await t.test("confirmation expiry timer consumes without closure", async () => {
      const d = seed("arm-timer", 203, "claimed");
      assert.equal((await transition(d, "arm-dispatch")).ok, true);
      const timer = scheduledTimers.at(-1);
      assert.ok(timer?.delay && timer.delay > 110_000);
      assert.equal((await transition(d, "confirm-dispatch")).ok, true);
      const confirmed = session.get(`dispatch:${d.id}`) as DispatchPayload;
      session.set(`dispatch:${d.id}`, { ...confirmed, expiresAt: Date.now() });
      timer.callback();
      await waitUntil(() => !session.has(`dispatch:${d.id}`) && badge(1203) === "✓");
      assert.equal(badge(203), undefined);
      assert.equal(scheduledTimers.some(item => item.delay === 0), false);
    });
    await t.test("only confirmed auto-close dispatches may close a still-inactive target", async () => {
      for (const [target, autoSubmit, autoClose, status] of [
        [204, false, true, "claimed"], [205, true, false, "submitting"],
        [206, true, true, "confirmed"], [207, true, true, "confirmed"],
        [208, true, true, "confirmed"]
      ] as const) {
        const d = seed(`complete-${target}`, target, status);
        Object.assign(d, { autoSubmit, autoClose });
        if (status !== "confirmed") assert.equal((await transition(d, "confirm-dispatch")).ok, false);
        const flushCloses = deferredCloses();
        assert.equal((await complete(d, true, "/")).ok, true);
        if (target === 207) activeTabs.add(target); // After completion but before deferred removal.
        const clock = target === 208 ? t.mock.method(Date, "now", () => d.expiresAt) : undefined;
        try {
          await flushCloses();
        } finally { clock?.mock.restore(); }
        assert.equal(session.has(`dispatch:${d.id}`), false);
        assert.equal(title(target + 1000), autoSubmit ? "Share to ChatGPT: prompt submitted" : "Share to ChatGPT: prompt ready in ChatGPT");
      }
      assert.deepEqual(closedTabs, [206]);
    });
    await t.test("fallback permission requires an unexpired claimed binding and does not advance it", async () => {
      const d = seed("insertion", 860, "claimed");
      const check = { type: "check-insertion", dispatchId: d.id } as const;
      assert.equal((await send(check, 861)).ok, false);
      assert.deepEqual(await send(check, 860), { ok: true });
      assert.deepEqual(session.get(`dispatch:${d.id}`), d);
      for (const status of ["pending", "submitting", "confirmed"] as const) {
        seed(d.id, 860, status);
        assert.equal((await send(check, 860)).ok, false);
      }
      seed(d.id, 860, "claimed", true);
      assert.equal((await send(check, 860)).ok, false);
      assert.equal(session.has(`dispatch:${d.id}`), false);
    });
    for (const type of ["check-insertion", "complete-dispatch"] as const) {
      await t.test(`${type} refuses prefill on a visited target even if content missed activation`, async () => {
        for (const signal of ["stored", "active", "visit"]) {
          const d = seed(`visit-${type}-${signal}`, 861, "claimed");
          d.autoSubmit = false;
          if (signal === "stored") session.set(`target-activated:${d.id}`, true);
          if (signal === "visit") visit(861);
          assert.equal((await send({ type, dispatchId: d.id, closeTab: false }, 861, undefined, signal === "active")).ok, false);
          assert.equal(badge(d.sourceTabId!), "!");
          assert.equal(session.has(`dispatch:${d.id}`), false);
        }
      });
    }
    for (const phase of ["creation", "binding", "before-claim", "claim-write", "arm-write"] as const) {
      await t.test(`a visit during ${phase} never authorizes insertion or Send`, async (st) => {
        const tabId = nextTabId;
        const create = st.mock.fn(() => { if (phase === "creation") visit(tabId); });
        hooks.beforeCreate = create;
        hooks.beforeWrite = items => {
          const payload = Object.entries(items).find(([key]) => key.startsWith("dispatch:"))?.[1] as DispatchPayload | undefined;
          if ((phase === "binding" && `tab-dispatch:${tabId}` in items) ||
              (phase === "claim-write" && payload?.status === "claimed") ||
              (phase === "arm-write" && payload?.status === "submitting")) visit(tabId);
        };
        localSettings = { autoSubmit: true };
        sharePage(69, "visit");
        await tick();
        assert.equal(create.mock.callCount(), 1);
        const d = dispatchEntries(session).find(record => record.targetTabId === tabId);
        if (d) {
          if (phase === "before-claim") visit(tabId);
          const claim = await transition(d, "claim-dispatch");
          if (phase === "arm-write") {
            assert.equal(claim.ok, true);
            assert.equal((await transition(d, "arm-dispatch")).ok, false);
          } else assert.equal(claim.ok, false);
        }
        assert.equal(badge(69), "!");
        assert.equal(session.has(`tab-dispatch:${tabId}`), false);
        assert.equal(dispatchEntries(session).some(record => record.targetTabId === tabId), false);
      });
    }
    await t.test("ordinary unrelated activation during creation does not suppress an untouched target", async () => {
      hooks.beforeCreate = () => visit(8000);
      sharePage(70, "untouched");
      const d = await navigationFrom(70);
      assert.equal((await transition(d, "claim-dispatch")).ok, true);
    });
    await t.test("a restart cannot lose a visit behind an in-flight confirmation write", async () => {
      const d = seed("blocked-confirm", 709, "submitting");
      const blocked = pauseWrite(`dispatch:${d.id}`);
      const confirmed = transition(d, "confirm-dispatch");
      await blocked.waitUntilBlocked();
      visit(709);
      // Snapshot available to a fresh worker, before the old dispatch queue can advance.
      const durableVisit = session.get(`target-activated:${d.id}`);
      blocked.release();
      assert.deepEqual(await confirmed, { ok: true });
      assert.equal(durableVisit, true);
      assert.deepEqual(await complete(d, true, "/"), { ok: true });
      assert.equal(session.has(`target-activated:${d.id}`), false);
    });
    await t.test("a failed veto write behind confirmation revokes first and reports the final confirmed status", async () => {
      const d = seed("failed-veto-confirm-write", 719, "submitting");
      const blocked = pauseWrite(`dispatch:${d.id}`);
      const confirmed = transition(d, "confirm-dispatch");
      await blocked.waitUntilBlocked();
      failWritePrefix = "target-activated:";
      visit(719);
      await tick();
      const stillBound = session.has("tab-dispatch:719");
      blocked.release();
      assert.equal((await confirmed).ok, true);
      assert.equal(stillBound, false);
      await waitUntil(() => !session.has(`dispatch:${d.id}`) && badge(d.sourceTabId!) === "✓");
      assert.equal(badgeUpdates.some(update => [719, d.sourceTabId].includes(update.tabId) && update.text === "!"), false);
    });
    await t.test("activation during failed consumption also revokes when its marker write fails", async () => {
      const d = seed("failed-consumption-veto", 718, "confirmed");
      let failRemoval = true;
      hooks.beforeRemove = keys => {
        if (failRemoval && keys.includes(`dispatch:${d.id}`)) {
          failRemoval = false;
          visit(718);
          throw new Error("Dispatch cleanup failed.");
        }
      };
      failWritePrefix = "target-activated:";
      const result = await complete(d, true, "/");
      assert.equal(result.ok, false);
      await tick();
      assertAbsent("tab-dispatch:718", `dispatch:${d.id}`);
      assert.equal(badge(d.sourceTabId!), "✓");
      assert.equal(closedTabs.includes(718), false);
    });
    await t.test("cleanup cannot leave an orphaned activation bit behind a delayed write", async () => {
      const d = seed("delayed-veto", 708, "confirmed");
      const key = `target-activated:${d.id}`;
      const blocked = pauseWrite(key);
      visit(708);
      const completion = complete(d, true, "/");
      await tick();
      blocked.release();
      assert.deepEqual(await completion, { ok: true });
      assert.equal(session.has(key), false);
    });
    await t.test("unrelated activations in a warm worker do not touch storage", async () => {
      await assertNoStorage(() => { for (let i = 8000; i < 8010; i++) visit(i); });
    });
    for (const [i, phase] of ["after-click", "cleanup", "deferred", "tabs.get"].entries()) {
      await t.test(`a visit during ${phase} preserves submitted status without removal`, async () => {
        const tabId = 710 + i;
        const d = seed(`visit-${phase}`, tabId, "submitting");
        if (phase === "after-click") visit(tabId);
        assert.deepEqual(await transition(d, "confirm-dispatch"), { ok: true });
        if (phase === "after-click") assert.equal(session.get(`target-activated:${d.id}`), true);
        if (phase === "cleanup") hooks.afterRemove = keys => { if (keys.includes(`dispatch:${d.id}`)) visit(tabId); };
        if (phase === "tabs.get") hooks.afterTabGet = visit;
        const flushCloses = deferredCloses();
        assert.deepEqual(await complete(d, true, "/"), { ok: true });
        if (phase === "deferred") visit(tabId);
        await flushCloses();
        assert.equal(badge(d.sourceTabId!), "✓");
        assert.equal(closedTabs.includes(tabId), false);
      });
    }
    await t.test("target failure cannot replace a newer source status, even during its queued write", async () => {
      const d = seed("now-a-source", 720, "claimed");
      const blocked = pauseWrite("source-status:720");
      sharePage(720, "newer");
      await blocked.waitUntilBlocked();
      const failed = fail(d, "older failure");
      await tick();
      blocked.release();
      assert.equal((await failed).ok, true);
      await tick();
      assert.equal(badgeUpdates.some(update => update.tabId === 720 && update.text === "!"), false);
      assert.equal(badge(720), "…");
      assert.equal(badge(d.sourceTabId!), "!");
    });
    for (const [index, mode] of ["timer", "navigation", "target removal"].entries()) {
      await t.test(`a ${mode} clear cannot restore an older target's failure ownership`, async () => {
        const tabId = 865 + index;
        const older = seed(`former-target-${mode}`, tabId, "claimed");
        localSettings = { autoSubmit: false };
        sharePage(tabId, "newer");
        const newer = await navigationFrom(tabId);
        if (mode === "timer") {
          await transition(newer, "claim-dispatch");
          await complete(newer, false);
          assert.equal(badge(tabId), "✓");
          scheduledTimers.at(-1)!.callback();
        } else if (mode === "navigation") navigate(tabId);
        else tabRemovedListener!(newer.targetTabId!, { isWindowClosing: false, windowId: 1 });
        await waitUntil(() => badge(tabId) === "");
        assert.deepEqual(await fail(older, "older"), { ok: true });
        assert.equal(badge(tabId), "");
        assert.equal(title(tabId), "Send this page to ChatGPT");
        assert.equal([...session.keys()].some(key => key.endsWith(`:${older.id}`)), false);
        assert.equal(session.has(`source-status:${tabId}`), false);
      });
    }
    await t.test("a worker-only refusal logs once without data and never changes success", async (st) => {
      const log = st.mock.method(console, "error", () => {});
      for (const [index, phase] of ["sender", "deferred", "lookup-error"].entries()) {
        const tabId = 870 + index;
        const d = seed(`private-id-${phase}`, tabId, "confirmed");
        currentLocation = { status: "complete", url: "https://chatgpt.com/private-route" };
        if (phase === "lookup-error") hooks.beforeTabGet = () => { throw new Error("private-detail"); };
        assert.equal(await closeResult(d, "/", phase === "sender" ? currentLocation.url : undefined), false);
        assert.equal(log.mock.callCount(), index + 1);
        const args = log.mock.calls[index]!.arguments;
        assert.equal(args.length, 1);
        assert.match(String(args[0]), /close|open/i);
        assert.doesNotMatch(String(args[0]), /private|https?:/i);
      }
    });
    await t.test("close evidence is required and cannot be substituted by matching Chrome snapshots", async () => {
      const canonical = "/c/00000000-0000-0000-0000-000000000001";
      for (const [i, [path, proof]] of [
        [canonical, undefined], ["/settings", canonical], ["/settings", "/settings"],
        [canonical, canonical.replace(/1$/, "2")]
      ].entries()) {
        const id = 810 + i;
        const d = seed(`proof-${i}`, id, "confirmed");
        const url = `https://chatgpt.com${path}`;
        currentLocation = { url, status: "complete" };
        assert.equal(await closeResult(d, proof, url), false, `case ${i}`);
      }
    });
    for (const [i, phase] of ["queued", "deferred", "tabs.get", "away-and-back"].entries()) {
      await t.test(`navigation during ${phase} invalidates even matching settled paths`, async () => {
        const tabId = 815 + i;
        const d = seed(`reload-${phase}`, tabId, "confirmed");
        currentLocation = { url: "https://chatgpt.com/", status: "complete" };
        const reload = () => {
          navigate(tabId);
          navigate(tabId, { status: "complete" });
        };
        if (phase === "tabs.get") hooks.beforeTabGet = reload;
        const flushCloses = deferredCloses();
        const completion = complete(d, true, "/");
        if (phase === "queued") reload();
        if (phase === "away-and-back") {
          for (const url of ["https://chatgpt.com/settings", "https://chatgpt.com/"]) {
            navigate(tabId, { url });
          }
        }
        assert.equal((await completion).ok, true);
        if (phase === "deferred") reload();
        await flushCloses();
        assert.equal(closedTabs.includes(tabId), false);
      });
    }
    await t.test("deferred removal requires the sender's exact conversation path on a settled tab", async () => {
      const conversation = "https://chatgpt.com/c/00000000-0000-0000-0000-000000000001";
      const local = conversation.replace("/c/", "/c/local-chatgpt%3A");
      const cases = [
        [conversation, { url: `${conversation}?view=1#tail` }, true],
        [local, { url: local }, true],
        [conversation, { url: conversation.replace(/1$/, "2") }, false],
        [local, { url: conversation }, false],
        [conversation, { url: conversation.replace("chatgpt.com", "example.com") }, false],
        [conversation, {}, false],
        [conversation, { url: conversation, pendingUrl: conversation }, false],
        [conversation, { url: conversation, status: "loading" }, false],
        ["", { url: "https://chatgpt.com/" }, false],
        ["https://example.com/", { url: "https://example.com/" }, false]
      ] as const;
      const actual = [];
      for (const [index, [senderUrl, location]] of cases.entries()) {
        const tabId = 300 + index;
        const d = seed(`nav-${index}`, tabId, "confirmed");
        currentLocation = { url: senderUrl, status: "complete" };
        const path = senderUrl ? new URL(senderUrl).pathname : "/";
        actual.push(await closeResult(d, path, senderUrl, { status: "complete", ...location }));
      }
      assert.deepEqual(actual, cases.map(([, , expected]) => expected));
    });
    const firstWorker = messageListener;
    await t.test("a failed activation write cannot authorize a restarted worker, even behind a transition", async () => {
      const pending = seed("failed-veto", 820, "pending");
      const confirmed = seed("failed-veto-confirmed", 821, "confirmed");
      const blocked = seed("failed-veto-blocked", 822, "claimed");
      const write = pauseWrite(`dispatch:${blocked.id}`, "target-activated:");
      const arm = transition(blocked, "arm-dispatch");
      await write.waitUntilBlocked();
      for (const tabId of [820, 821, 822]) visit(tabId);
      await tick();

      // Start a fresh copy of the production worker against the same session storage.
      await restartWorker();
      assert.notEqual(messageListener, firstWorker);
      const pendingResult = await transition(pending, "claim-dispatch");
      // Do not allow the restarted worker to wait on a new arm write if it erroneously grants it.
      hooks.beforeWrite = undefined;
      const blockedResult = await transition(blocked, "arm-dispatch");
      write.release();
      assert.equal((await arm).ok, false);
      assert.equal(pendingResult.ok, false);
      assert.equal(blockedResult.ok, false);
      await tick();
      for (const d of [pending, confirmed, blocked]) {
        assertAbsent(`dispatch:${d.id}`, `tab-dispatch:${d.targetTabId}`, `target-activated:${d.id}`);
      }
      assert.equal(badge(confirmed.sourceTabId!), "✓");
      assert.equal(badge(confirmed.targetTabId!), undefined);
    });
    await t.test("cleared newer status still suppresses an older target after a fresh worker starts", async () => {
      const older = seed("older-after-restart", 875, "claimed");
      sharePage(875, "newer");
      await navigationFrom(875);
      navigate(875);
      await waitUntil(() => badge(875) === "");
      await restartWorker();
      assert.equal((await fail(older, "older")).ok, true);
      assert.equal(badge(875), "");
      assert.equal([...session.keys()].some(key => key.endsWith(`:${older.id}`)), false);
    });
    const coldReads = [["healthy", 0], ["transiently failing", 1], ["persistently failing", Infinity]] as const;
    for (const [index, [health, failures]] of coldReads.entries()) {
      await t.test(`a ${health} cold binding lookup preserves latest source status`, async () => {
        const older = seed(`older-source-${index}`, 920 + index, "confirmed");
        const tabId = older.sourceTabId!;
        const key = `source-status:${tabId}`;

        const startup = gate();
        let scans = 0;
        hooks.beforeRead = keys => { if (keys === null && ++scans === 1) return startup.wait; };
        const reads = failReads(keys => keys === `tab-dispatch:${tabId}`, failures);
        try {
          await restartWorker();
          const count = createdTabs.length;
          sharePage(tabId, "newer");
          await tick();
          const failed = failures === Infinity;
          assert.deepEqual(await complete(older, false), { ok: true });
          assert.equal(badge(tabId), failed ? "!" : "…");
          assert.equal(reads(), failures === 0 ? 1 : 2);
          assert.notEqual(session.get(key), older.id);
          assert.equal(createdTabs.length, count + (failed ? 0 : 1));
          if (!failed) assert.equal(session.get(key), lastNavigation()!.id);
          else {
            navigate(tabId);
            await waitUntil(() => badge(tabId) === "");
          }
        } finally { startup.release(); await tick(); }
        const warm = reads();
        await nextShare(tabId, "newer");
        assert.equal(reads(), warm, "the warm source path must not look up the binding");
      });
    }
    await t.test("a visit after a failed startup scan vetoes close in the next worker, even before recovery finishes", async () => {
      const d = seed("visit-after-failed-scan", 890, "confirmed");

      const retry = gate();
      hooks.beforeRead = keys => { if (keys === null) return retry.wait; };
      failReads(keys => keys === null, 1);
      failReads(keys => keys === "tab-dispatch:890", 1);
      await restartWorker();
      visit(890);
      await tick();
      hooks.beforeRead = undefined;
      currentLocation = { status: "complete", url: "https://chatgpt.com/" };
      const flushCloses = deferredCloses();
      await restartWorker();
      try {
        assert.deepEqual(await complete(d, true, "/"), { ok: true });
        await flushCloses();
        assert.equal(closedTabs.includes(890), false);
        assert.equal(session.has(`target-activated:${d.id}`), false);
      } finally { retry.release(); }
    });
    await t.test("a cold activation lookup cannot veto a reassigned or already consumed binding", async () => {
      const removed = seed("cold-removed", 893, "confirmed");
      const replaced = seed("cold-replaced", 894, "confirmed");
      const scan = gate(), lookup = gate();
      let pendingValidations = 0;
      hooks.beforeRead = keys => { if (keys === null) return scan.wait; };
      hooks.afterRead = keys => {
        if (Array.isArray(keys) && (keys.includes("tab-dispatch:893") || keys.includes("tab-dispatch:894"))) {
          pendingValidations++;
          return lookup.wait;
        }
      };
      await restartWorker();
      try {
        visit(893); visit(894);
        await waitUntil(() => pendingValidations === 2);
        await storageArea.remove([`dispatch:${removed.id}`, "tab-dispatch:893"]);
        const replacement: DispatchPayload = { ...replaced, id: "replacement-after-cold-visit", status: "pending" };
        await storageArea.set({ [`dispatch:${replacement.id}`]: replacement, "tab-dispatch:894": replacement.id });
        lookup.release();
        await tick();
        assertAbsent(`target-activated:${removed.id}`, `target-activated:${replaced.id}`);
        assert.equal((await transition(replacement, "claim-dispatch")).ok, true);
      } finally { lookup.release(); scan.release(); await tick(); }
    });
    await t.test("a persistent repair failure backs off without replaying siblings or blocking a fresh share", async () => {
      const d = seed("persistently-unreadable", 895, "confirmed");
      const healthy = seed("sibling-deadline", 896, "claimed");
      healthy.expiresAt = Date.now() + 60_000;

      const failures = failReads(keys => Array.isArray(keys) && keys.includes(`dispatch:${d.id}`));
      const timers = await restartTimers();
      assert.equal(failures(), 2);
      assert.equal(timers.filter(timer => (timer.delay ?? 0) > 55_000).length, 1);
      const retry = timers.filter(timer => (timer.delay ?? 0) > 0 && timer.delay! < 2000);
      assert.equal(retry.length, 1);
      const beforeRetry = scheduledTimers.length;
      retry[0]!.callback();
      await tick();
      assert.equal(failures(), 3);
      assert.equal(scheduledTimers.length, beforeRetry);
      unrelatedVisits();
      const fresh = await nextShare(897, "during-fault");
      assert.equal((await transition(fresh, "claim-dispatch")).ok, true);
    });
    for (const fault of ["scan", "repair"] as const) {
      await t.test(`one transient startup ${fault} error still restores deadlines and releases the cold visit buffer`, async () => {
        const d = seed(`retry-${fault}`, 891, "confirmed");
        const attempts = failReads(keys => fault === "scan" ? keys === null : Array.isArray(keys) && keys.includes(`dispatch:${d.id}`), 1);
        const timers = await restartTimers();
        assert.ok(attempts() > 0);
        session.set(`dispatch:${d.id}`, { ...d, expiresAt: Date.now() });
        timers.filter(timer => (timer.delay ?? 0) > 2000).forEach(timer => timer.callback());
        await tick();
        assert.equal(session.has(`dispatch:${d.id}`), false, "the live deadline must have been restored");
        await assertNoStorage(unrelatedVisits);
        const dispatched = await nextShare(892, "after-retry");
        assert.equal((await transition(dispatched, "claim-dispatch")).ok, true);
      });
    }
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

// A restart registers a new worker against the same Chrome events and session storage.
function workerEvent<T>() {
  return { listener: undefined as T | undefined, addListener(listener: T) { this.listener = listener; } };
}

function gate() {
  let release!: () => void;
  const wait = new Promise<void>(done => { release = done; });
  return { wait, release };
}

let workerNumber = 0;
async function restartWorker(): Promise<void> {
  // Resolve at runtime so the test bundle does not include esbuild's binary loader.
  const { buildSync } = createRequire(`${process.cwd()}/package.json`)("esbuild") as typeof import("esbuild");
  const bundle = buildSync({ entryPoints: ["src/background.ts"], bundle: true, format: "esm", write: false });
  await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0]!.contents).toString("base64")}#${++workerNumber}`);
}

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
  tabId: number,
  senderUrl = "https://chatgpt.com/",
  active = false
): Promise<DispatchResponse> {
  return await new Promise((resolve, reject) => {
    const keepChannelOpen = listener(message, {
      // Chromium keeps the document's starting URL after same-document navigation.
      url: "https://chatgpt.com/",
      tab: { id: tabId, url: senderUrl || undefined, active } as chrome.tabs.Tab
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
