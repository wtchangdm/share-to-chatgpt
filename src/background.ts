import {
  armDispatch,
  canCompleteDispatch,
  claimDispatch,
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
const DISPATCH_TIMEOUT_MS = 15_000;
const SUCCESS_BADGE_MS = 2_000;
const PROGRESS_ACTION_TITLE = "Share to ChatGPT: dispatch in progress";
const SUBMITTED_ACTION_TITLE = "Share to ChatGPT: prompt submitted";
const PREFILLED_ACTION_TITLE = "Share to ChatGPT: prompt ready in ChatGPT";
const sourceStatusQueues = new Map<number, Promise<void>>();

function dispatchKey(dispatchId: string): string {
  return `${DISPATCH_STORAGE_PREFIX}${dispatchId}`;
}

function tabKey(tabId: number): string {
  return `${TAB_PREFIX}${tabId}`;
}

function sourceStatusKey(tabId: number): string {
  return `${SOURCE_STATUS_PREFIX}${tabId}`;
}

async function getDispatch(dispatchId: string): Promise<DispatchPayload | undefined> {
  const key = dispatchKey(dispatchId);
  const result = await chrome.storage.session.get(key);
  return result[key] as DispatchPayload | undefined;
}

async function saveDispatch(dispatch: DispatchPayload): Promise<void> {
  await chrome.storage.session.set({ [dispatchKey(dispatch.id)]: dispatch });
}

async function setBadge(
  tabId: number | undefined,
  text: string,
  color = "#C62828"
): Promise<void> {
  if (tabId === undefined) {
    return;
  }

  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color });
    await chrome.action.setBadgeText({ tabId, text });
  } catch {
    // The source or target tab may have closed.
  }
}

async function setActionTitle(tabId: number | undefined, title: string): Promise<void> {
  if (tabId === undefined) {
    return;
  }

  try {
    await chrome.action.setTitle({ tabId, title });
  } catch {
    // The source or target tab may have closed.
  }
}

async function clearTabDiagnostic(tabId: number | undefined): Promise<void> {
  await Promise.all([
    setBadge(tabId, ""),
    setActionTitle(tabId, DEFAULT_ACTION_TITLE)
  ]);
}

async function setFailureDiagnostic(
  tabId: number | undefined,
  error: string
): Promise<void> {
  await Promise.all([
    setBadge(tabId, "!"),
    setActionTitle(tabId, getFailureActionTitle(error))
  ]);
}

function queueSourceStatus(tabId: number, update: () => Promise<void>): Promise<void> {
  const previous = sourceStatusQueues.get(tabId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(update)
    .catch((error: unknown) => {
      console.error("[Share to ChatGPT] Could not update source-tab status:", error);
    });
  sourceStatusQueues.set(tabId, next);
  return next.finally(() => {
    if (sourceStatusQueues.get(tabId) === next) {
      sourceStatusQueues.delete(tabId);
    }
  });
}

async function sourceOwnsStatus(dispatch: DispatchPayload): Promise<boolean> {
  if (dispatch.sourceTabId === undefined) {
    return false;
  }
  const key = sourceStatusKey(dispatch.sourceTabId);
  const result = await chrome.storage.session.get(key);
  return result[key] === dispatch.id;
}

async function startSourceStatus(dispatch: DispatchPayload): Promise<void> {
  if (dispatch.sourceTabId === undefined) {
    return;
  }
  const tabId = dispatch.sourceTabId;
  await queueSourceStatus(tabId, async () => {
    await chrome.storage.session.set({ [sourceStatusKey(tabId)]: dispatch.id });
    await Promise.all([
      setBadge(tabId, "…", "#1565C0"),
      setActionTitle(tabId, PROGRESS_ACTION_TITLE)
    ]);
  });
}

async function setSourceFailureStatus(
  dispatch: DispatchPayload,
  error: string
): Promise<void> {
  if (dispatch.sourceTabId === undefined) {
    return;
  }
  await queueSourceStatus(dispatch.sourceTabId, async () => {
    if (await sourceOwnsStatus(dispatch)) {
      await setFailureDiagnostic(dispatch.sourceTabId, error);
    }
  });
}

async function clearSourceStatus(dispatch: DispatchPayload): Promise<void> {
  if (dispatch.sourceTabId === undefined) {
    return;
  }
  const tabId = dispatch.sourceTabId;
  await queueSourceStatus(tabId, async () => {
    if (!await sourceOwnsStatus(dispatch)) {
      return;
    }
    await chrome.storage.session.remove(sourceStatusKey(tabId));
    await clearTabDiagnostic(tabId);
  });
}

async function setSourceSuccessStatus(
  dispatch: DispatchPayload,
  submitted: boolean
): Promise<void> {
  if (dispatch.sourceTabId === undefined) {
    return;
  }
  await queueSourceStatus(dispatch.sourceTabId, async () => {
    if (!await sourceOwnsStatus(dispatch)) {
      return;
    }
    await Promise.all([
      setBadge(dispatch.sourceTabId, "✓", "#2E7D32"),
      setActionTitle(
        dispatch.sourceTabId,
        submitted ? SUBMITTED_ACTION_TITLE : PREFILLED_ACTION_TITLE
      )
    ]);
    setTimeout(() => {
      void clearSourceStatus(dispatch);
    }, SUCCESS_BADGE_MS);
  });
}

async function clearSourceStatusOnNavigation(tabId: number): Promise<void> {
  await queueSourceStatus(tabId, async () => {
    const key = sourceStatusKey(tabId);
    const result = await chrome.storage.session.get(key);
    if (typeof result[key] !== "string") {
      return;
    }
    await chrome.storage.session.remove(key);
    await clearTabDiagnostic(tabId);
  });
}

async function clearDispatch(dispatch: DispatchPayload): Promise<void> {
  const keys = [dispatchKey(dispatch.id)];
  if (dispatch.targetTabId !== undefined) {
    keys.push(tabKey(dispatch.targetTabId));
  }
  await chrome.storage.session.remove(keys);
}

async function failDispatch(dispatch: DispatchPayload, error: string): Promise<void> {
  console.error(`[Share to ChatGPT] ${error}`, {
    dispatchId: dispatch.id
  });
  await Promise.all([
    setSourceFailureStatus(dispatch, error),
    setFailureDiagnostic(dispatch.targetTabId, error)
  ]);
  await clearDispatch(dispatch);
}

async function expireDispatch(dispatchId: string): Promise<void> {
  const dispatch = await getDispatch(dispatchId);
  if (dispatch && Date.now() >= dispatch.expiresAt) {
    await failDispatch(dispatch, "Dispatch timed out before submission completed.");
  }
}

function scheduleExpiration(dispatch: DispatchPayload): void {
  const delay = Math.max(0, dispatch.expiresAt - Date.now());
  setTimeout(() => {
    void expireDispatch(dispatch.id);
  }, delay);
}

async function readSettings(): Promise<Settings> {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(result[SETTINGS_KEY] as Partial<Settings> | undefined);
}

async function createDispatch(
  targetUrl: string,
  sourceTabId?: number
): Promise<void> {
  await cleanExpiredDispatches();

  const settings = await readSettings();
  const prompt = buildPrompt(targetUrl, settings);
  const now = Date.now();
  const dispatch: DispatchPayload = {
    id: crypto.randomUUID(),
    prompt,
    sourceTabId,
    createdAt: now,
    expiresAt: now + DISPATCH_TIMEOUT_MS,
    status: "pending",
    autoSubmit: settings.autoSubmit,
    autoClose: settings.autoClose
  };

  await saveDispatch(dispatch);
  await startSourceStatus(dispatch);

  try {
    const url = buildChatGPTUrl(prompt, dispatch.id);
    const createdTab = await chrome.tabs.create({
      url: "about:blank",
      active: false
    });

    if (createdTab.id === undefined) {
      throw new Error("Chrome did not return an ID for the new ChatGPT tab.");
    }

    dispatch.targetTabId = createdTab.id;
    await Promise.all([
      saveDispatch(dispatch),
      chrome.storage.session.set({ [tabKey(createdTab.id)]: dispatch.id })
    ]);
    scheduleExpiration(dispatch);
    await chrome.tabs.update(createdTab.id, { url });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failDispatch(dispatch, `Could not open ChatGPT: ${message}`);
  }
}

async function shareShortcutTarget(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id === undefined) {
    console.error("[Share to ChatGPT] The active tab ID is unavailable.");
    return;
  }

  await cleanExpiredDispatches();
  await clearTabDiagnostic(tab.id);

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: getShortcutTargetUrl
    });
    const targetUrl = results[0]?.result;
    if (typeof targetUrl !== "string" || targetUrl.length === 0) {
      throw new Error("The shortcut target URL is unavailable.");
    }

    await createDispatch(targetUrl, tab.id);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const message = `Could not send the shortcut target: ${detail}`;
    console.error(`[Share to ChatGPT] ${message}`);
    await setFailureDiagnostic(tab.id, message);
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

  return candidate.type === "claim-dispatch" ||
    candidate.type === "arm-dispatch";
}

function isChatGPTSender(sender: chrome.runtime.MessageSender): sender is chrome.runtime.MessageSender & {
  tab: chrome.tabs.Tab & { id: number };
} {
  return sender.url?.startsWith("https://chatgpt.com/") === true &&
    sender.tab?.id !== undefined;
}

async function handleContentMessage(
  message: ContentMessage,
  sender: chrome.runtime.MessageSender
): Promise<DispatchResponse> {
  if (!isChatGPTSender(sender)) {
    return { ok: false, error: "Dispatch messages are accepted only from chatgpt.com tabs." };
  }

  const dispatch = await getDispatch(message.dispatchId);
  if (!dispatch) {
    return { ok: false, error: "Dispatch state is missing or already consumed." };
  }

  if (Date.now() >= dispatch.expiresAt) {
    await failDispatch(dispatch, "Dispatch expired before the ChatGPT composer became ready.");
    return { ok: false, error: "Dispatch expired." };
  }

  if (dispatch.targetTabId !== undefined && dispatch.targetTabId !== sender.tab.id) {
    return { ok: false, error: "Dispatch belongs to a different tab." };
  }

  if (message.type === "claim-dispatch") {
    const claimed = claimDispatch(dispatch, sender.tab.id);
    if (!claimed.ok) {
      return claimed;
    }
    await Promise.all([
      saveDispatch(claimed.dispatch),
      chrome.storage.session.set({ [tabKey(sender.tab.id)]: dispatch.id })
    ]);
    return { ok: true, dispatch: claimed.dispatch };
  }

  if (message.type === "arm-dispatch") {
    const armed = armDispatch(dispatch, sender.tab.id);
    if (!armed.ok) {
      return armed;
    }
    await saveDispatch(armed.dispatch);
    return { ok: true };
  }

  if (message.type === "complete-dispatch") {
    if (!canCompleteDispatch(dispatch)) {
      return { ok: false, error: "Dispatch did not reach its expected completion state." };
    }

    const submitted = dispatch.status === "submitting";
    const shouldCloseTab = submitted && dispatch.autoClose && message.closeTab;
    await Promise.all([
      setSourceSuccessStatus(dispatch, submitted),
      clearDispatch(dispatch)
    ]);
    if (shouldCloseTab) {
      setTimeout(() => {
        void chrome.tabs.remove(sender.tab.id).catch((error: unknown) => {
          console.error("[Share to ChatGPT] Could not close the submitted tab:", error);
        });
      }, 0);
    }
    return { ok: true };
  }

  await failDispatch(dispatch, message.error);
  return { ok: true };
}

async function cleanExpiredDispatches(): Promise<void> {
  const entries = await chrome.storage.session.get(null);
  const expired = findExpiredDispatches(entries, Date.now());

  await Promise.all(expired.map((dispatch) => failDispatch(
    dispatch,
    "Removed an expired dispatch during cleanup."
  )));
}

chrome.runtime.onInstalled.addListener(() => {
  void registerContextMenu();
});

chrome.action.onClicked.addListener((tab) => {
  if (!tab.url) {
    const error = "The active tab URL is unavailable.";
    void setFailureDiagnostic(tab.id, error);
    console.error(`[Share to ChatGPT] ${error}`);
    return;
  }

  void createDispatch(tab.url, tab.id);
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID || !info.linkUrl) {
    return;
  }

  void createDispatch(info.linkUrl, tab?.id);
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "send-hovered-link-to-chatgpt") {
    void shareShortcutTarget(tab);
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    void clearSourceStatusOnNavigation(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    const key = tabKey(tabId);
    const result = await chrome.storage.session.get(key);
    const dispatchId = result[key];
    if (typeof dispatchId === "string") {
      const dispatch = await getDispatch(dispatchId);
      if (dispatch) {
        await Promise.all([
          clearSourceStatus(dispatch),
          clearDispatch(dispatch)
        ]);
      } else {
        await chrome.storage.session.remove(key);
      }
    }
    await chrome.storage.session.remove(sourceStatusKey(tabId));
    sourceStatusQueues.delete(tabId);
  })();
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!isContentMessage(message)) {
    return false;
  }

  void handleContentMessage(message, sender)
    .then(sendResponse)
    .catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      console.error("[Share to ChatGPT] Message handling failed:", detail);
      sendResponse({ ok: false, error: detail } satisfies DispatchResponse);
    });
  return true;
});

void cleanExpiredDispatches();
