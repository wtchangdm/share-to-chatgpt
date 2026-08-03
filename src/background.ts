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
const DISPATCH_PREFIX = "dispatch:";
const TAB_PREFIX = "tab-dispatch:";
const DISPATCH_TIMEOUT_MS = 15_000;

function dispatchKey(dispatchId: string): string {
  return `${DISPATCH_PREFIX}${dispatchId}`;
}

function tabKey(tabId: number): string {
  return `${TAB_PREFIX}${tabId}`;
}

async function getDispatch(dispatchId: string): Promise<DispatchPayload | undefined> {
  const key = dispatchKey(dispatchId);
  const result = await chrome.storage.session.get(key);
  return result[key] as DispatchPayload | undefined;
}

async function saveDispatch(dispatch: DispatchPayload): Promise<void> {
  await chrome.storage.session.set({ [dispatchKey(dispatch.id)]: dispatch });
}

async function setBadge(tabId: number | undefined, text: string): Promise<void> {
  if (tabId === undefined) {
    return;
  }

  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#C62828" });
    await chrome.action.setBadgeText({ tabId, text });
  } catch {
    // The source or target tab may have closed.
  }
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
    setBadge(dispatch.sourceTabId, "!"),
    setBadge(dispatch.targetTabId, "!")
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
  sourceUrl: string,
  sourceTitle: string,
  sourceTabId?: number
): Promise<void> {
  await setBadge(sourceTabId, "");

  const settings = await readSettings();
  const prompt = buildPrompt(sourceUrl, settings);
  const now = Date.now();
  const dispatch: DispatchPayload = {
    id: crypto.randomUUID(),
    prompt,
    sourceUrl,
    sourceTitle,
    sourceTabId,
    createdAt: now,
    expiresAt: now + DISPATCH_TIMEOUT_MS,
    status: "pending",
    autoSubmit: settings.autoSubmit,
    autoClose: settings.autoClose
  };

  await saveDispatch(dispatch);

  try {
    const url = buildChatGPTUrl(prompt, dispatch.id);
    const createdTab = await chrome.tabs.create({
      url,
      active: false
    });

    if (createdTab.id === undefined) {
      throw new Error("Chrome did not return an ID for the new ChatGPT tab.");
    }

    const latest = await getDispatch(dispatch.id);
    if (latest) {
      latest.targetTabId = createdTab.id;
      await Promise.all([
        saveDispatch(latest),
        chrome.storage.session.set({ [tabKey(createdTab.id)]: dispatch.id })
      ]);
      scheduleExpiration(latest);
    }
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

  await setBadge(tab.id, "");

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: getShortcutTargetUrl
    });
    const targetUrl = results[0]?.result;
    if (typeof targetUrl !== "string" || targetUrl.length === 0) {
      throw new Error("The shortcut target URL is unavailable.");
    }

    await createDispatch(targetUrl, tab.title ?? "", tab.id);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[Share to ChatGPT] Could not send the shortcut target: ${detail}`);
    await setBadge(tab.id, "!");
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
  dispatch.targetTabId = sender.tab.id;

  if (message.type === "claim-dispatch") {
    if (dispatch.status !== "pending") {
      return { ok: false, error: "Dispatch was already claimed." };
    }
    dispatch.status = "claimed";
    await Promise.all([
      saveDispatch(dispatch),
      chrome.storage.session.set({ [tabKey(sender.tab.id)]: dispatch.id })
    ]);
    return { ok: true, dispatch };
  }

  if (message.type === "arm-dispatch") {
    if (dispatch.status !== "claimed") {
      return { ok: false, error: "Dispatch is not ready to submit." };
    }
    dispatch.status = "submitting";
    await saveDispatch(dispatch);
    return { ok: true };
  }

  if (message.type === "complete-dispatch") {
    const submitted = dispatch.status === "submitting";
    const prefilledOnly = dispatch.status === "claimed" && !dispatch.autoSubmit;
    if (!submitted && !prefilledOnly) {
      return { ok: false, error: "Dispatch did not reach its expected completion state." };
    }

    const shouldCloseTab = submitted && dispatch.autoClose && message.closeTab;
    await clearDispatch(dispatch);
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
  const expired = Object.entries(entries)
    .filter(([key, value]) => key.startsWith(DISPATCH_PREFIX) &&
      typeof value === "object" && value !== null &&
      "expiresAt" in value && typeof value.expiresAt === "number" &&
      value.expiresAt <= Date.now())
    .map(([, value]) => value as DispatchPayload);

  await Promise.all(expired.map((dispatch) => failDispatch(
    dispatch,
    "Removed an expired dispatch after the service worker restarted."
  )));
}

chrome.runtime.onInstalled.addListener(() => {
  void registerContextMenu();
});

chrome.action.onClicked.addListener((tab) => {
  if (!tab.url) {
    void setBadge(tab.id, "!");
    console.error("[Share to ChatGPT] The active tab URL is unavailable.");
    return;
  }

  void createDispatch(tab.url, tab.title ?? "", tab.id);
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID || !info.linkUrl) {
    return;
  }

  void createDispatch(info.linkUrl, tab?.title ?? "", tab?.id);
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "send-hovered-link-to-chatgpt") {
    void shareShortcutTarget(tab);
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
        await clearDispatch(dispatch);
      } else {
        await chrome.storage.session.remove(key);
      }
    }
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
