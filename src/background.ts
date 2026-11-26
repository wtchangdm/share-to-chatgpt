import {
  armDispatch,
  canCompleteDispatch,
  claimDispatch,
  confirmDispatch,
  DISPATCH_STORAGE_PREFIX,
  findExpiredDispatches
} from "./dispatch-policy";
import {
  DEFAULT_ACTION_TITLE,
  getFailureActionTitle
} from "./diagnostics";
import { getShortcutTargetUrl } from "./hovered-link";
import { buildChatGPTUrl, buildPrompt, normalizeSettings } from "./prompt";
import type {
  ContentMessage,
  DispatchPayload,
  DispatchResponse,
  Settings
} from "./types";

const CONTEXT_MENU_ID = "send-link-to-chatgpt";
const SETTINGS_KEY = "settings";
const TAB_PREFIX = "tab-dispatch:";
const SOURCE_STATUS_PREFIX = "source-status:";
const ACTIVATION_PREFIX = "target-activated:";
const SUPERSEDED_PREFIX = "target-superseded:";
const DISPATCH_TIMEOUT_MS = 15_000;
const AUTO_CLOSE_RESPONSE_TIMEOUT_MS = 120_000;
const SUCCESS_BADGE_MS = 2_000;
const PROGRESS_ACTION_TITLE = "Share to ChatGPT: dispatch in progress";
const SUBMITTED_ACTION_TITLE = "Share to ChatGPT: prompt submitted";
const PREFILLED_ACTION_TITLE = "Share to ChatGPT: prompt ready in ChatGPT";
const sourceStatusQueues = new Map<number, Promise<void>>();
// Preserve invocation ordering and navigation cleanup even if an owner write fails.
const unpersistedSourceOwners = new Map<number, string>();
const dispatchQueues = new Map<string, Promise<void>>();

interface TargetWatch {
  id: string;
  activated: boolean;
  visitWrite?: Promise<void>;
  consuming?: boolean;
  closing?: boolean;
}
const targetWatches = new Map<number, TargetWatch>();
// Only indexed candidates with a cold binding read in flight, never unrelated visits.
const coldBindingReads = new Map<number, string>();

interface CloseAttempt { tabId: number; path: string; deferred?: boolean }
// Membership means no navigation has invalidated this request since its receipt.
const closeAttempts = new Set<CloseAttempt>();
const CLOSE_CONVERSATION_PATH = /^\/c\/(?:local-chatgpt%3A)?[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\/?$/i;

// Only while Chrome has not returned the new tab ID or the startup index.
// Overflow means uncertainty: veto automation instead of collecting more IDs.
const MAX_UNBOUND_VISITS = 16;
class UnboundVisits {
  private readonly ids = new Set<number>();
  note(tabId: number): void { if (this.ids.size <= MAX_UNBOUND_VISITS) this.ids.add(tabId); }
  includes(tabId: number): boolean { return this.ids.size > MAX_UNBOUND_VISITS || this.ids.has(tabId); }
}
let recoveryVisits: UnboundVisits | undefined = new UnboundVisits();
const unboundVisits = new Set([recoveryVisits]);

type SourceStatusOwner = Pick<DispatchPayload, "id" | "sourceTabId">;

function runBackground(task: Promise<void>): void {
  void task.catch((error: unknown) => {
    console.error("[Share to ChatGPT] Background operation failed:", error);
  });
}

function dispatchKey(dispatchId: string): string {
  return `${DISPATCH_STORAGE_PREFIX}${dispatchId}`;
}

function tabKey(tabId: number): string {
  return `${TAB_PREFIX}${tabId}`;
}

function activationKey(id: string): string {
  return `${ACTIVATION_PREFIX}${id}`;
}

function sourceStatusKey(tabId: number): string {
  return `${SOURCE_STATUS_PREFIX}${tabId}`;
}

async function sessionValue<T = unknown>(key: string): Promise<T | undefined> {
  return (await chrome.storage.session.get(key))[key] as T | undefined;
}

function getDispatch(id: string): Promise<DispatchPayload | undefined> {
  return sessionValue<DispatchPayload>(dispatchKey(id));
}

async function saveDispatch(dispatch: DispatchPayload): Promise<void> {
  await chrome.storage.session.set({ [dispatchKey(dispatch.id)]: dispatch });
}

async function writeBadge(tabId: number, text: string, color: string): Promise<void> {
  await chrome.action.setBadgeBackgroundColor({ tabId, color });
  await chrome.action.setBadgeText({ tabId, text });
}

async function setTabStatus(tabId: number, text: string, title: string, color = "#C62828"): Promise<void> {
  // Attempt both updates independently; either can fail if the tab closes.
  const badge = writeBadge(tabId, text, color).catch(() => undefined);
  try { await chrome.action.setTitle({ tabId, title }); } catch { /* Tab may have closed. */ }
  await badge;
}

function setFailureDiagnostic(tabId: number, error: string): Promise<void> {
  return setTabStatus(tabId, "!", getFailureActionTitle(error));
}

// Return cleanup for this entry only: settling a task must not release its successor.
function setQueueTail<K>(queue: Map<K, Promise<void>>, key: K, tail: Promise<void>): () => void {
  queue.set(key, tail);
  return () => { if (queue.get(key) === tail) queue.delete(key); };
}

function queueDispatch<T>(id: string, update: () => Promise<T>): Promise<T> {
  const result = (dispatchQueues.get(id) ?? Promise.resolve()).then(update);
  const settled = result.then(() => undefined, () => undefined);
  return result.finally(setQueueTail(dispatchQueues, id, settled));
}

function queueSourceStatus(tabId: number, update: () => Promise<void>): Promise<void> {
  const previous = sourceStatusQueues.get(tabId) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(update);
  return result.finally(setQueueTail(sourceStatusQueues, tabId, result));
}

function persistActivation(tabId: number, watch: TargetWatch): Promise<void> {
  return watch.visitWrite ??= chrome.storage.session.set({ [activationKey(watch.id)]: true }).catch(async () => {
    // Payload transitions never rewrite the tab index. Revoking it must not wait
    // for that queue; final diagnostics do wait, so a confirmed write stays green.
    try {
      if (targetWatches.get(tabId) === watch) await chrome.storage.session.remove(tabKey(tabId));
    } finally {
      runBackground(queueDispatch(watch.id, async () => {
        const dispatch = await getDispatch(watch.id);
        if (dispatch) await consumeAfterError(dispatch, "The target tab was activated.");
      }));
    }
  });
}

function markActivated(tabId: number, watch: TargetWatch): void {
  if (watch.activated) return;
  watch.activated = true;
  // After cleanup starts, only this worker's deferred callback can still remove the tab.
  if (!watch.consuming) runBackground(persistActivation(tabId, watch));
}

function watchTarget(tabId: number, id: string, inheritStartupVisits = true): TargetWatch {
  let watch = targetWatches.get(tabId);
  if (watch?.id !== id) {
    watch = { id, activated: false };
    targetWatches.set(tabId, watch);
    if (inheritStartupVisits && recoveryVisits?.includes(tabId)) markActivated(tabId, watch);
  }
  return watch;
}

function forgetTarget(tabId: number, id: string): void {
  const watch = targetWatches.get(tabId);
  if (watch?.id === id && !watch.closing) targetWatches.delete(tabId);
}

async function updateOwnedSource(
  { id, sourceTabId: tabId }: SourceStatusOwner, update: (tabId: number) => Promise<void>
): Promise<void> {
  if (tabId === undefined) return;
  await queueSourceStatus(tabId, async () => {
    const owner = unpersistedSourceOwners.get(tabId) ?? await sessionValue(sourceStatusKey(tabId));
    if (owner === id) await update(tabId);
  });
}

async function startSourceStatus({ id, sourceTabId: tabId }: SourceStatusOwner): Promise<void> {
  if (tabId === undefined) return;
  await queueSourceStatus(tabId, async () => {
    // Only a dispatch target can lose target-badge ownership to a newer invocation.
    // Keep that fact until the older dispatch is consumed, not just until this badge clears.
    let superseded: Record<string, boolean> | undefined;
    try {
      const watch = targetWatches.get(tabId);
      let prior: unknown = watch?.id;
      if (!watch && recoveryVisits) {
        prior = await retryOnce(() => sessionValue(tabKey(tabId)));
      }
      if (!watch?.consuming && typeof prior === "string") superseded = { [`${SUPERSEDED_PREFIX}${prior}`]: true };
      await chrome.storage.session.set({ ...superseded, [sourceStatusKey(tabId)]: id });
    } catch (error) {
      unpersistedSourceOwners.set(tabId, id);
      if (superseded) await chrome.storage.session.set(superseded);
      await chrome.storage.session.remove(sourceStatusKey(tabId));
      throw error;
    }
    unpersistedSourceOwners.delete(tabId);
    await setTabStatus(tabId, "…", PROGRESS_ACTION_TITLE, "#1565C0");
  });
}

function setSourceFailureStatus(dispatch: SourceStatusOwner, error: string): Promise<void> {
  return updateOwnedSource(dispatch, tabId => setFailureDiagnostic(tabId, error));
}

async function setTargetFailureStatus(dispatch: DispatchPayload, error: string): Promise<void> {
  const tabId = dispatch.targetTabId;
  if (tabId === undefined) return;
  await queueSourceStatus(tabId, async () => {
    // This target was newly created. A different source owner on it is necessarily newer.
    const key = sourceStatusKey(tabId);
    const suppressed = `${SUPERSEDED_PREFIX}${dispatch.id}`;
    const index = tabKey(tabId);
    const entries = await chrome.storage.session.get([key, suppressed, index]);
    const owner = unpersistedSourceOwners.get(tabId) ?? entries[key];
    if (entries[suppressed] !== true && (entries[index] === undefined || entries[index] === dispatch.id) &&
        (owner === undefined || owner === dispatch.id)) await setFailureDiagnostic(tabId, error);
  });
}

function clearSourceStatus(dispatch: DispatchPayload): Promise<void> {
  return updateOwnedSource(dispatch, async tabId => {
    await chrome.storage.session.remove(sourceStatusKey(tabId));
    await setTabStatus(tabId, "", DEFAULT_ACTION_TITLE);
  });
}

function setSourceSuccessStatus(dispatch: DispatchPayload): Promise<void> {
  return updateOwnedSource(dispatch, async tabId => {
    const title = dispatch.autoSubmit ? SUBMITTED_ACTION_TITLE : PREFILLED_ACTION_TITLE;
    await setTabStatus(tabId, "✓", title, "#2E7D32");
    setTimeout(() => runBackground(clearSourceStatus(dispatch)), SUCCESS_BADGE_MS);
  });
}

async function clearSourceStatusOnNavigation(tabId: number): Promise<void> {
  await queueSourceStatus(tabId, async () => {
    const key = sourceStatusKey(tabId);
    if (!unpersistedSourceOwners.has(tabId) && typeof (await sessionValue(key)) !== "string") return;
    await chrome.storage.session.remove(key);
    unpersistedSourceOwners.delete(tabId);
    await setTabStatus(tabId, "", DEFAULT_ACTION_TITLE);
  });
}

async function clearDispatch(dispatch: DispatchPayload): Promise<void> {
  const tabId = dispatch.targetTabId;
  const keys = [dispatchKey(dispatch.id), activationKey(dispatch.id), `${SUPERSEDED_PREFIX}${dispatch.id}`];
  if (tabId === undefined) return chrome.storage.session.remove(keys);
  // Serialize terminal removal with source invocations on this same tab so a
  // late supersession write cannot outlive its dispatch.
  return queueSourceStatus(tabId, () => clearBoundDispatch(dispatch.id, tabId, keys));
}

async function clearBoundDispatch(id: string, tabId: number, keys: string[]): Promise<void> {
  const watch = targetWatches.get(tabId);
  if (watch?.id === id) {
    watch.consuming = true;
    // Even a failed veto write cannot authorize close; always attempt state cleanup.
    if (watch.visitWrite) await watch.visitWrite.catch(() => undefined);
  }
  try {
    const index = tabKey(tabId);
    if ((await chrome.storage.session.get(index))[index] === id) keys.push(index);
    await chrome.storage.session.remove(keys);
  } catch (error) {
    if (watch?.id === id) {
      watch.consuming = false;
      if (watch.activated) await persistActivation(tabId, watch);
    }
    throw error;
  }
  forgetTarget(tabId, id);
}

async function failDispatch(dispatch: DispatchPayload, error: string): Promise<void> {
  console.error(`[Share to ChatGPT] ${error}`, {
    dispatchId: dispatch.id
  });
  await Promise.all([
    setSourceFailureStatus(dispatch, error),
    setTargetFailureStatus(dispatch, error),
    clearDispatch(dispatch)
  ]);
}

async function finishDispatch(dispatch: DispatchPayload): Promise<void> {
  await Promise.all([
    setSourceSuccessStatus(dispatch),
    clearDispatch(dispatch)
  ]);
}

async function consumeAfterError(dispatch: DispatchPayload, error: string): Promise<void> {
  if (dispatch.status !== "confirmed") {
    await failDispatch(dispatch, error);
    return;
  }
  console.error("[Share to ChatGPT] Submission was confirmed; leaving the tab open.");
  await finishDispatch(dispatch);
}

async function expireDispatch(
  dispatchId: string,
  error = "Dispatch timed out before submission completed."
): Promise<void> {
  await queueDispatch(dispatchId, async () => {
    const dispatch = await getDispatch(dispatchId);
    if (dispatch && Date.now() >= dispatch.expiresAt) {
      await consumeAfterError(dispatch, error);
    }
  });
}

function scheduleExpiration(dispatch: DispatchPayload): void {
  const delay = Math.max(0, dispatch.expiresAt - Date.now());
  setTimeout(() => {
    runBackground(expireDispatch(dispatch.id));
  }, delay);
}

async function readSettings(): Promise<Settings> {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(result[SETTINGS_KEY] as Partial<Settings> | undefined);
}

async function createDispatch(
  sourceTabId: number | undefined,
  readTarget: () => string | undefined | Promise<string>
): Promise<void> {
  const owner: SourceStatusOwner = { id: crypto.randomUUID(), sourceTabId };
  let dispatch: DispatchPayload | undefined;
  try {
    // Capture hover and enqueue ownership in the invocation stack, without
    // waiting for storage, action updates, or an earlier invocation's lookup.
    const [targetUrl] = await Promise.all([readTarget(), startSourceStatus(owner)]);
    if (!targetUrl) throw new Error("The active tab URL is unavailable.");
    await cleanExpiredDispatches();
    const settings = await readSettings();
    const prompt = buildPrompt(targetUrl, settings);
    const now = Date.now();
    dispatch = {
      ...owner, prompt, createdAt: now, expiresAt: now + DISPATCH_TIMEOUT_MS,
      status: "pending", autoSubmit: settings.autoSubmit, autoClose: settings.autoClose
    };
    await saveDispatch(dispatch);
    const url = buildChatGPTUrl(prompt, dispatch.id);
    const visits = new UnboundVisits();
    unboundVisits.add(visits);
    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.create({ url: "about:blank", active: false });
    } finally { unboundVisits.delete(visits); }
    const tabId = tab.id;
    if (tabId === undefined) throw new Error("Chrome did not return an ID for the new ChatGPT tab.");
    dispatch.targetTabId = tabId;
    // This tab did not exist before create(); only its own creation window counts.
    const watch = watchTarget(tabId, dispatch.id, false);
    if (tab.active || visits.includes(tabId)) throw new Error("The target tab was activated.");
    const bound = dispatch;
    await queueDispatch(bound.id, async () => {
      // Install the revocable index first. A late binding write must not be able
      // to restore both the index and a bound payload across worker restart.
      await chrome.storage.session.set({ [tabKey(tabId)]: bound.id });
      if (watch.activated) throw new Error("The target tab was activated.");
      await saveDispatch(bound);
      if (watch.activated) throw new Error("The target tab was activated.");
      scheduleExpiration(bound);
      await chrome.tabs.update(tabId, { url });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (dispatch) {
      const failed = dispatch;
      await queueDispatch(failed.id, () => failDispatch(failed, `Could not open ChatGPT: ${message}`));
    } else {
      console.error(`[Share to ChatGPT] ${message}`);
      await setSourceFailureStatus(owner, message);
    }
  }
}

async function readShortcutTarget(tabId: number | undefined): Promise<string> {
  if (tabId === undefined) throw new Error("The active tab ID is unavailable.");
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      injectImmediately: true,
      func: getShortcutTargetUrl
    });
    const targetUrl = results[0]?.result;
    if (typeof targetUrl !== "string" || targetUrl.length === 0) {
      throw new Error("The shortcut target URL is unavailable.");
    }

    return targetUrl;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not send the shortcut target: ${detail}`);
  }
}

async function registerContextMenu(): Promise<void> {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: CONTEXT_MENU_ID,
    title: "Send link to ChatGPT",
    contexts: ["link"]
  });
}

function isContentMessage(value: unknown): value is ContentMessage {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as { type?: unknown; dispatchId?: unknown; error?: unknown };
  if (typeof candidate.dispatchId !== "string") {
    return false;
  }

  if (candidate.type === "fail-dispatch") {
    return typeof candidate.error === "string";
  }

  if (candidate.type === "complete-dispatch") {
    return typeof (candidate as { closeTab?: unknown }).closeTab === "boolean";
  }

  return candidate.type === "claim-dispatch" || candidate.type === "check-insertion" ||
    candidate.type === "arm-dispatch" || candidate.type === "confirm-dispatch";
}

function isChatGPTSender(sender: chrome.runtime.MessageSender): sender is chrome.runtime.MessageSender & {
  tab: chrome.tabs.Tab & { id: number };
} {
  return sender.url?.startsWith("https://chatgpt.com/") === true &&
    sender.tab?.id !== undefined;
}

async function rejectVisit(dispatch: DispatchPayload): Promise<DispatchResponse> {
  const error = "The target tab was activated; refusing to automate it.";
  await failDispatch(dispatch, error);
  return { ok: false, error };
}

async function handleContentMessage(
  message: ContentMessage,
  sender: chrome.runtime.MessageSender,
  close: CloseAttempt | undefined
): Promise<DispatchResponse> {
  if (!isChatGPTSender(sender)) {
    return { ok: false, error: "Dispatch messages are accepted only from chatgpt.com tabs." };
  }

  const key = dispatchKey(message.dispatchId);
  const visited = activationKey(message.dispatchId);
  const index = tabKey(sender.tab.id);
  const entries = await chrome.storage.session.get([key, visited, index]);
  const dispatch = entries[key] as DispatchPayload | undefined;
  if (!dispatch) {
    return { ok: false, error: "Dispatch state is missing or already consumed." };
  }

  if (dispatch.targetTabId !== sender.tab.id) {
    return { ok: false, error: "Dispatch belongs to a different tab." };
  }
  if (entries[index] !== dispatch.id) {
    return { ok: false, error: "Dispatch target binding is no longer valid." };
  }
  if (Date.now() >= dispatch.expiresAt) {
    await consumeAfterError(dispatch, "Dispatch expired.");
    if (dispatch.status === "confirmed" &&
        (message.type === "complete-dispatch" || message.type === "fail-dispatch")) {
      return { ok: true };
    }
    return { ok: false, error: "Dispatch expired." };
  }

  const tabId = sender.tab.id;
  const watch = watchTarget(tabId, dispatch.id);
  if (entries[visited] === true) watch.activated = true;
  if (sender.tab.active) markActivated(tabId, watch);

  if (message.type === "claim-dispatch" || message.type === "arm-dispatch") {
    const transition = message.type === "claim-dispatch" ? claimDispatch(dispatch, tabId) : armDispatch(dispatch, tabId);
    if (!transition.ok) return transition;
    const next = transition.dispatch;
    const extendLease = next.status === "submitting" && next.autoClose;
    if (extendLease) next.expiresAt = Date.now() + AUTO_CLOSE_RESPONSE_TIMEOUT_MS;
    if (watch.activated) return rejectVisit(dispatch);
    await saveDispatch(next);
    if (watch.activated) return rejectVisit(dispatch);
    if (extendLease) scheduleExpiration(next);
    return transition;
  }

  if (message.type === "check-insertion") {
    if (dispatch.status !== "claimed") return { ok: false, error: "Dispatch is not ready for insertion." };
    return watch.activated || sender.tab.active !== false ? rejectVisit(dispatch) : { ok: true };
  }

  if (message.type === "confirm-dispatch") {
    const confirmed = confirmDispatch(dispatch, tabId);
    if (!confirmed.ok) return confirmed;
    await saveDispatch(confirmed.dispatch);
    return { ok: true };
  }

  if (message.type === "complete-dispatch") {
    if (!canCompleteDispatch(dispatch)) {
      return { ok: false, error: "Dispatch did not reach its expected completion state." };
    }

    if (!dispatch.autoSubmit && (watch.activated || sender.tab.active !== false)) return rejectVisit(dispatch);
    if (dispatch.status !== "confirmed" || watch.activated || !close || !closeAttempts.has(close)) {
      if (message.closeTab) logSkippedClose();
      await finishDispatch(dispatch);
    } else {
      // Transfer the live veto across session cleanup and the response-channel handoff.
      watch.closing = true;
      try {
        await finishDispatch(dispatch);
        const { expiresAt } = dispatch;
        close.deferred = true;
        setTimeout(() => { runBackground(closeIfUnchanged(close, expiresAt, watch)); }, 0);
      } catch (error) {
        watch.closing = false;
        if (!await getDispatch(watch.id)) forgetTarget(tabId, watch.id);
        throw error;
      }
    }
    return { ok: true };
  }

  await consumeAfterError(dispatch, message.error);
  return { ok: true };
}

function chatGPTPath(url: string | undefined): string | undefined {
  return url?.startsWith("https://chatgpt.com/") ? new URL(url).pathname : undefined;
}

function logSkippedClose(): void {
  console.error("[Share to ChatGPT] Automatic close not verified; leaving the tab open.");
}

async function closeIfUnchanged(close: CloseAttempt, expiresAt: number, watch: TargetWatch): Promise<void> {
  const { tabId, path } = close;
  let removed = false;
  try {
    if (!closeAttempts.has(close) || watch.activated) return;
    const tab = await chrome.tabs.get(tabId);
    // A pending destination outside our host permission need not expose pendingUrl.
    if (closeAttempts.has(close) && !watch.activated && targetWatches.get(tabId) === watch && tab.active === false &&
        tab.status === "complete" && tab.pendingUrl === undefined && chatGPTPath(tab.url) === path &&
        Date.now() < expiresAt) {
      await chrome.tabs.remove(tabId);
      removed = true;
    }
  } catch {
    // Chrome's error may include the URL or other private details.
  } finally {
    if (!removed) logSkippedClose();
    closeAttempts.delete(close);
    watch.closing = false;
    forgetTarget(tabId, watch.id);
  }
}

async function retryOnce<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch { return operation(); }
}

// Retry discovery or a single failed repair, never replay successful siblings or
// hold a dispatch queue across backoff. A persistent outage stops after three tries.
async function retryRecovery<T>(operation: () => Promise<T>): Promise<T> {
  try { return await retryOnce(operation); } catch {
    await new Promise<void>(done => setTimeout(done, 250));
    return operation();
  }
}

async function recoverSession(): Promise<void> {
  const entries = await retryRecovery(() => chrome.storage.session.get(null));
  // The snapshot discovers work; it never authorizes removal or automation.
  const targets = new Map<string, Set<number>>();
  for (const [key, value] of Object.entries(entries)) {
    let id: string;
    let tabId: number | undefined;
    if (key.startsWith(TAB_PREFIX) && typeof value === "string") {
      id = value;
      tabId = Number(key.slice(TAB_PREFIX.length));
      if (!Number.isInteger(tabId) || tabKey(tabId) !== key) continue;
    } else if (key.startsWith(DISPATCH_STORAGE_PREFIX)) {
      id = key.slice(DISPATCH_STORAGE_PREFIX.length);
      tabId = (value as DispatchPayload | null)?.targetTabId;
    } else if (key.startsWith(ACTIVATION_PREFIX)) id = key.slice(ACTIVATION_PREFIX.length);
    else if (key.startsWith(SUPERSEDED_PREFIX)) id = key.slice(SUPERSEDED_PREFIX.length);
    else continue;
    const tabs = targets.get(id) ?? new Set<number>();
    if (typeof tabId === "number") tabs.add(tabId);
    targets.set(id, tabs);
  }
  await Promise.all(Array.from(targets, ([id, tabs]) =>
    retryRecovery(() => queueDispatch(id, () => reconcileDispatch(id, tabs)))
  ));
  if (recoveryVisits) unboundVisits.delete(recoveryVisits);
  recoveryVisits = undefined;
}

async function reconcileDispatch(id: string, tabs: Set<number>): Promise<void> {
  const key = dispatchKey(id);
  const latest = await chrome.storage.session.get([key, ...Array.from(tabs, tabKey)]);
  const dispatch = latest[key] as DispatchPayload | undefined;
  const target = dispatch?.targetTabId;
  const orphanKeys = [];
  const orphanWrites: Promise<void>[] = [];
  for (const tabId of tabs) {
    if (latest[tabKey(tabId)] === id && tabId !== target) {
      orphanKeys.push(tabKey(tabId));
      const watch = targetWatches.get(tabId);
      if (watch?.id === id && watch.visitWrite) orphanWrites.push(watch.visitWrite);
      forgetTarget(tabId, id);
    }
  }
  if (orphanKeys.length) await chrome.storage.session.remove(orphanKeys);
  if (!dispatch) {
    // A visit that woke the worker may have started a write for the orphan index.
    await Promise.allSettled(orphanWrites);
    if (!await getDispatch(id)) await chrome.storage.session.remove([activationKey(id), `${SUPERSEDED_PREFIX}${id}`]);
    return;
  }
  if (target !== undefined) {
    const index = tabKey(target);
    const binding = tabs.has(target) ? latest[index] : (await chrome.storage.session.get(index))[index];
    if (binding !== id) return consumeAfterError(dispatch, "The target tab binding was revoked.");
    watchTarget(target, id);
  }
  if (Date.now() >= dispatch.expiresAt) await consumeAfterError(dispatch, "Removed an expired dispatch during cleanup.");
  else scheduleExpiration(dispatch);
}

async function cleanExpiredDispatches(): Promise<void> {
  const entries = await chrome.storage.session.get(null);
  const expired = findExpiredDispatches(entries, Date.now());

  await Promise.all(expired.map((dispatch) => expireDispatch(
    dispatch.id,
    "Removed an expired dispatch during cleanup."
  )));
}

chrome.runtime.onInstalled.addListener(() => {
  runBackground(registerContextMenu());
});

chrome.action.onClicked.addListener((tab) => {
  runBackground(createDispatch(tab.id, () => tab.url));
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID) {
    return;
  }

  runBackground(createDispatch(tab?.id, () => info.linkUrl));
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "send-hovered-link-to-chatgpt") {
    runBackground(createDispatch(tab?.id, () => readShortcutTarget(tab?.id)));
  }
});

// Discovery may be blocked (or out of retries). Persist an existing binding's
// veto independently of its startup scan; never write an unrelated tab ID.
async function latchColdVisit(tabId: number): Promise<void> {
  const index = tabKey(tabId);
  const id = await retryOnce(() => sessionValue(index));
  if (typeof id !== "string") return;
  await queueDispatch(id, async () => {
    if (!recoveryVisits || targetWatches.has(tabId)) return;
    // The first lookup only discovered a candidate. Cleanup, reassignment or a
    // partial binding cannot authorize an orphan marker or replace a newer watch.
    const key = dispatchKey(id);
    coldBindingReads.set(tabId, id);
    try {
      const latest = await retryOnce(() => chrome.storage.session.get([index, key]));
      if (coldBindingReads.get(tabId) === id && latest[index] === id &&
          (latest[key] as DispatchPayload | undefined)?.targetTabId === tabId && !targetWatches.has(tabId)) {
        markActivated(tabId, watchTarget(tabId, id));
      }
    } finally {
      if (coldBindingReads.get(tabId) === id) coldBindingReads.delete(tabId);
    }
  });
}

chrome.tabs.onActivated.addListener(({ tabId }) => {
  for (const visits of unboundVisits) visits.note(tabId);
  const watch = targetWatches.get(tabId);
  if (watch) markActivated(tabId, watch);
  else if (recoveryVisits) runBackground(latchColdVisit(tabId));
});

// Session index changes include bound dispatches seeded from the Options page.
chrome.storage.session.onChanged.addListener((changes) => {
  for (const [key, { oldValue, newValue }] of Object.entries(changes)) {
    if (!key.startsWith(TAB_PREFIX)) continue;
    const tabId = Number(key.slice(TAB_PREFIX.length));
    coldBindingReads.delete(tabId);
    if (typeof newValue === "string") watchTarget(tabId, newValue, oldValue === undefined);
    else if (typeof oldValue === "string") forgetTarget(tabId, oldValue);
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" || changeInfo.url !== undefined) {
    for (const close of closeAttempts) {
      if (close.tabId === tabId && (changeInfo.status === "loading" || chatGPTPath(changeInfo.url) !== close.path)) {
        closeAttempts.delete(close);
      }
    }
  }
  if (changeInfo.status === "loading") {
    runBackground(clearSourceStatusOnNavigation(tabId));
  }
});

async function clearRemovedTarget(tabId: number): Promise<void> {
  const index = tabKey(tabId);
  const id = await sessionValue(index);
  if (typeof id !== "string") return;
  await queueDispatch(id, async () => {
    const key = dispatchKey(id);
    const latest = await chrome.storage.session.get([index, key]);
    if (latest[index] !== id) return;
    const dispatch = latest[key] as DispatchPayload | undefined;
    if (dispatch?.targetTabId === tabId) {
      await Promise.all([clearSourceStatus(dispatch), clearDispatch(dispatch)]);
    } else {
      await chrome.storage.session.remove(index);
    }
  });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  runBackground(queueSourceStatus(tabId, async () => {
    unpersistedSourceOwners.delete(tabId);
    await chrome.storage.session.remove(sourceStatusKey(tabId));
  }));
  runBackground(clearRemovedTarget(tabId));
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!isContentMessage(message)) {
    return false;
  }

  // sender.url identifies the starting document, not its current SPA route.
  // Latch navigation synchronously, including while waiting for the dispatch queue.
  const path = message.type === "complete-dispatch" && message.closeTab ? message.closePath : undefined;
  const close: CloseAttempt | undefined = typeof path === "string" && (path === "/" || CLOSE_CONVERSATION_PATH.test(path)) &&
    isChatGPTSender(sender) && chatGPTPath(sender.tab.url) === path ? { tabId: sender.tab.id, path } : undefined;
  if (close) closeAttempts.add(close);
  void queueDispatch(
    message.dispatchId,
    () => handleContentMessage(message, sender, close)
  )
    .then(sendResponse)
    .catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      console.error("[Share to ChatGPT] Message handling failed:", detail);
      sendResponse({ ok: false, error: detail } satisfies DispatchResponse);
    }).finally(() => {
      if (close && !close.deferred) closeAttempts.delete(close);
    });
  return true;
});

runBackground(recoverSession());
