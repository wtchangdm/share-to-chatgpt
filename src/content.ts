import {
  countStartedAssistantMessages,
  findComposer,
  findComposerForm,
  findObservationRoot,
  findResponseStopButton,
  findSendButton,
  isSendButtonEnabled,
  OBSERVED_ATTRIBUTES,
  readComposerText,
  type ComposerElement
} from "./selectors";
import { isSubmissionConfirmed } from "./submission";
import type { ContentMessage, DispatchPayload, DispatchResponse } from "./types";

const MARKER_PREFIX = "#share-to-chatgpt-dispatch=";
const PERSISTED_CONVERSATION_PATH =
  /^\/c\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\/?$/i;
const PREFILL_GRACE_MS = 4_000;
const PROMPT_UPDATE_TIMEOUT_MS = 3_000;
const SUBMISSION_CONFIRM_TIMEOUT_MS = 2_000;

export function isPersistedConversationPath(pathname: string): boolean {
  return PERSISTED_CONVERSATION_PATH.test(pathname);
}

export function takeDispatchId(): string | null {
  if (!location.hash.startsWith(MARKER_PREFIX)) return null;
  let dispatchId: string;
  try {
    dispatchId = decodeURIComponent(location.hash.slice(MARKER_PREFIX.length));
  } catch {
    return null;
  }
  history.replaceState(history.state, "", `${location.pathname}${location.search}`);
  return dispatchId;
}

function normalizeComposerText(text: string): string {
  return text.replaceAll("\u00a0", " ").replaceAll("\r\n", "\n").trim();
}

function readComposerPromptMatch(composer: ComposerElement, prompt: string): boolean | null {
  const text = readComposerText(composer);
  return text === null ? null : normalizeComposerText(text) === normalizeComposerText(prompt);
}

export function composerHasPrompt(composer: ComposerElement, prompt: string): boolean {
  return readComposerPromptMatch(composer, prompt) === true;
}

export function waitFor<T>(readValue: () => T | null, deadline: number): Promise<T | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let root = findObservationRoot();
    const options: MutationObserverInit = {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: OBSERVED_ATTRIBUTES
    };
    const cleanup = (): void => {
      settled = true;
      observer.disconnect();
      clearInterval(intervalId);
      clearTimeout(timeoutId);
    };
    const finish = (value: T | null): void => {
      if (settled) return;
      cleanup();
      resolve(value);
    };
    const check = (): void => {
      if (settled) return;
      try {
        if (Date.now() >= deadline) {
          finish(null);
          return;
        }
        // React can replace main. Polling also recovers a detached observation root.
        if (root !== document && !root.isConnected) {
          observer.disconnect();
          root = findObservationRoot();
          observer.observe(root, options);
        }
        const value = readValue();
        if (value !== null) finish(value);
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    const observer = new MutationObserver(check);
    observer.observe(root, options);
    const intervalId = window.setInterval(check, 250);
    const timeoutId = window.setTimeout(() => finish(null), Math.max(0, deadline - Date.now()));
    check();
  });
}

export function createAssistantResponseTracker(
  initialMessageCount: number,
  readMessageCount: () => number = countStartedAssistantMessages
): () => boolean {
  let started = false;
  return () => {
    if (!started) started = readMessageCount() > initialMessageCount;
    return started;
  };
}

export function createAutoCloseCheck(initialMessageCount: number): () => true | null {
  let streamingSeen = false;
  const assistantStarted = createAssistantResponseTracker(initialMessageCount);
  return () => {
    const composer = findComposer();
    if (!composer) return null;
    const stop = findResponseStopButton(composer);
    const streaming = stop !== null && isSendButtonEnabled(stop);
    if (streaming) streamingSeen = true;
    const persisted = isPersistedConversationPath(location.pathname);
    // The observed enabled Stop control and canonical path are enough. Do not
    // scan streamed text or wait for message IDs, which arrive only at completion.
    if (persisted && streaming) return true;
    if (!persisted && (!streamingSeen || stop)) return null;
    return assistantStarted() ? true : null;
  };
}

async function sendMessage(message: ContentMessage): Promise<DispatchResponse> {
  return await chrome.runtime.sendMessage(message) as DispatchResponse;
}

export function insertPrompt(composer: ComposerElement, prompt: string): void {
  if (composer instanceof HTMLTextAreaElement) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    if (!setter) throw new Error("The native textarea value setter is unavailable.");
    setter.call(composer, prompt);
  } else {
    composer.focus({ preventScroll: true });
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(composer);
    selection?.removeAllRanges();
    selection?.addRange(range);
    if (document.execCommand("insertText", false, prompt) && composerHasPrompt(composer, prompt)) {
      return;
    }
    const paragraph = document.createElement("p");
    // The native setter creates <br> nodes instead of collapsible newline text.
    paragraph.innerText = prompt;
    composer.replaceChildren(paragraph);
  }
  composer.dispatchEvent(new InputEvent("input", {
    bubbles: true,
    composed: true,
    data: prompt,
    inputType: "insertText"
  }));
}

async function preparePrompt(dispatch: DispatchPayload): Promise<void> {
  const deadline = dispatch.expiresAt;
  if (!await waitFor(findComposer, deadline)) {
    throw new Error(
      "ChatGPT composer did not appear before timeout. The user may be logged out, " +
      "an interstitial may be blocking the page, or ChatGPT's DOM may have changed."
    );
  }
  const readVerifiedComposer = (): ComposerElement | null => {
    const composer = findComposer();
    return composer && composerHasPrompt(composer, dispatch.prompt) ? composer : null;
  };
  const prefilled = await waitFor(readVerifiedComposer, Math.min(deadline, Date.now() + PREFILL_GRACE_MS));
  if (prefilled) return;
  const composer = findComposer();
  if (!composer) throw new Error("The ChatGPT composer disappeared before prompt injection.");
  insertPrompt(composer, dispatch.prompt);
  if (!await waitFor(readVerifiedComposer, Math.min(deadline, Date.now() + PROMPT_UPDATE_TIMEOUT_MS))) {
    throw new Error("Prompt injection failed; the composer did not contain the expected prompt.");
  }
}

function readReadySubmission(prompt: string): {
  composer: ComposerElement;
  button: HTMLButtonElement;
} | null {
  const composer = findComposer();
  if (!composer || !composerHasPrompt(composer, prompt)) return null;
  const button = findSendButton(composer);
  return button && isSendButtonEnabled(button) ? { composer, button } : null;
}

function submitPrompt(composer: ComposerElement, button: HTMLButtonElement): void {
  const form = findComposerForm(composer);
  if (form) {
    try {
      form.requestSubmit(button);
      return;
    } catch (error) {
      console.warn("[Share to ChatGPT] form.requestSubmit failed; using button.click().", error);
    }
  }
  button.click();
}

async function submitAndObserve(dispatch: DispatchPayload): Promise<boolean> {
  if (!await waitFor(() => readReadySubmission(dispatch.prompt), dispatch.expiresAt)) {
    throw new Error("The expected prompt could not be verified with an enabled Send button before timeout.");
  }
  const armed = await sendMessage({ type: "arm-dispatch", dispatchId: dispatch.id });
  if (!armed.ok) throw new Error(armed.error);

  // Arming crosses an asynchronous boundary. Never submit a stale composer or
  // prompt captured before the service worker replied, and never re-arm/retry.
  const ready = readReadySubmission(dispatch.prompt);
  if (!ready) {
    throw new Error("The expected prompt or enabled Send button changed while arming; refusing to submit.");
  }
  const closeCheck = dispatch.autoClose
    ? createAutoCloseCheck(countStartedAssistantMessages())
    : null;
  submitPrompt(ready.composer, ready.button);

  const submitted = await waitFor(() => {
    const composer = findComposer();
    if (!composer) return null;
    const button = findSendButton(composer);
    return isSubmissionConfirmed({
      composerPresent: true,
      composerHasExpectedPrompt: readComposerPromptMatch(composer, dispatch.prompt),
      sendButtonEnabled: button ? isSendButtonEnabled(button) : null
    }) ? true : null;
  }, Math.min(dispatch.expiresAt, Date.now() + SUBMISSION_CONFIRM_TIMEOUT_MS));
  if (!submitted) {
    throw new Error("Submission could not be confirmed after invoking the composer form.");
  }
  if (!closeCheck) return false;

  const deadline = armed.dispatch?.expiresAt ?? dispatch.expiresAt;
  const closeTab = await waitFor(closeCheck, deadline - 500) === true;
  if (!closeTab) {
    console.error(
      "[Share to ChatGPT] Submission succeeded, but conversation persistence or " +
      "response completion could not be verified before timeout; leaving the tab open."
    );
  }
  return closeTab;
}

async function reportFailure(dispatchId: string, error: string): Promise<void> {
  console.error(`[Share to ChatGPT] ${error}`);
  try {
    await sendMessage({ type: "fail-dispatch", dispatchId, error });
  } catch (messageError) {
    console.error("[Share to ChatGPT] Could not report the failure:", messageError);
  }
}

export async function runDispatch(dispatchId: string): Promise<void> {
  let dispatch: DispatchPayload | undefined;
  try {
    const claim = await sendMessage({ type: "claim-dispatch", dispatchId });
    if (!claim.ok || !claim.dispatch) {
      throw new Error(claim.ok ? "Dispatch payload was missing." : claim.error);
    }
    dispatch = claim.dispatch;
    await preparePrompt(dispatch);
    const closeTab = dispatch.autoSubmit ? await submitAndObserve(dispatch) : false;
    const completed = await sendMessage({ type: "complete-dispatch", dispatchId, closeTab });
    if (!completed.ok) throw new Error(completed.error);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (dispatch) await reportFailure(dispatchId, detail);
    else console.error(`[Share to ChatGPT] ${detail}`);
  }
}

if (typeof location !== "undefined") {
  const dispatchId = takeDispatchId();
  if (dispatchId) void runDispatch(dispatchId);
}
