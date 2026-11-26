import {
  countStartedAssistantMessages,
  findComposer,
  findObservationRoot,
  findResponseStopButton,
  findSendButton,
  isModelSelectorEnabled,
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
const LOCAL_CONVERSATION_PATH =
  /^\/c\/local-chatgpt%3A[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\/?$/i;
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

export function waitFor<T>(readValue: () => T | null, deadline: number, signal?: AbortSignal): Promise<T | null> {
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
      signal?.removeEventListener("abort", cancel);
      observer.disconnect();
      clearInterval(intervalId);
      clearTimeout(timeoutId);
    };
    const finish = (value: T | null): void => {
      if (settled) return;
      cleanup();
      resolve(value);
    };
    const cancel = (): void => finish(null);
    const check = (): void => {
      if (settled) return;
      try {
        if (Date.now() >= deadline) {
          finish(null);
          return;
        }
        // Page switches can retain the previous main in the DOM. Polling also
        // detects active-page changes outside the currently observed subtree.
        const currentRoot = findObservationRoot();
        if (root !== currentRoot) {
          observer.disconnect();
          root = currentRoot;
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
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    else check();
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

export function createAutoCloseCheck(initialMessageCount: number): () => string | null {
  let streamingSeen = false;
  const assistantStarted = createAssistantResponseTracker(initialMessageCount);
  return () => {
    const composer = findComposer();
    if (!composer) return null;
    const stop = findResponseStopButton(composer);
    const streaming = stop !== null && isSendButtonEnabled(stop);
    if (streaming) streamingSeen = true;
    const pathname = location.pathname;
    const persisted = isPersistedConversationPath(pathname);
    // The observed enabled Stop control and canonical path are enough. Do not
    // scan streamed text or wait for message IDs, which arrive only at completion.
    if (persisted && streaming) return pathname;
    if (!persisted && (!streamingSeen || stop)) return null;
    return assistantStarted() ? pathname : null;
  };
}

async function sendMessage(message: ContentMessage): Promise<DispatchResponse> {
  return await chrome.runtime.sendMessage(message) as DispatchResponse;
}

export function insertPrompt(composer: ComposerElement, prompt: string, requireTarget: () => void): void {
  const canWrite = (): boolean => {
    if (findComposer() !== composer || readComposerText(composer) !== "") return false;
    requireTarget();
    return true;
  };
  if (!canWrite()) return;
  if (composer instanceof HTMLTextAreaElement) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    if (!setter) throw new Error("The native textarea value setter is unavailable.");
    setter.call(composer, prompt);
  } else {
    const focusedAndEmpty = (): boolean => document.activeElement === composer && canWrite();
    composer.focus({ preventScroll: true });
    if (!focusedAndEmpty()) return;
    // Chromium can turn native multiline insertion into an unreadable block
    // structure. Plan the exact paragraph up front, rather than replacing an
    // unidentifiable draft after native input handlers have run.
    if (!prompt.includes("\n")) {
      const selection = window.getSelection();
      if (!selection) return;
      const range = document.createRange();
      range.selectNodeContents(composer);
      selection.removeAllRanges();
      selection.addRange(range);
      if (!composer.contains(selection.anchorNode) || !composer.contains(selection.focusNode) || !focusedAndEmpty()) return;
      document.execCommand("insertText", false, prompt);
      // A command's boolean return cannot establish ownership of the result.
      // Leave exact, partial, and unreadable text to the read-only verifier.
      if (!focusedAndEmpty()) return;
    }
    const paragraph = document.createElement("p");
    // The native setter creates <br> nodes instead of collapsible newline text.
    paragraph.innerText = prompt;
    if (!focusedAndEmpty()) return;
    composer.replaceChildren(paragraph);
  }
  composer.dispatchEvent(new InputEvent("input", {
    bubbles: true,
    composed: true,
    data: prompt,
    inputType: "insertText"
  }));
}

// Observe from before claim until completion. Polling alone can miss a visit
// to the tab or a same-document route change that is reversed between checks.
class DispatchTarget {
  private owned = true;
  private clicked = false;
  private path = "/";
  private readonly navigation = (window as Window & { navigation?: EventTarget }).navigation;

  constructor() {
    this.navigation?.addEventListener("currententrychange", this.check);
    document.addEventListener("visibilitychange", this.check);
    this.check();
  }

  private acceptsPath(next: string): boolean {
    if (next === this.path) return true;
    if (!this.clicked) return false;
    if (this.path === "/") return LOCAL_CONVERSATION_PATH.test(next) || isPersistedConversationPath(next);
    return LOCAL_CONVERSATION_PATH.test(this.path) && isPersistedConversationPath(next);
  }

  readonly check = (): boolean => {
    if (this.owned) {
      const next = location.pathname;
      this.owned = !!this.navigation && document.visibilityState === "hidden" && this.acceptsPath(next);
      this.path = next;
    }
    return this.owned;
  };

  require(deadline: number): void {
    if (!this.check()) throw new Error("The background target or its expected conversation route changed.");
    if (!(Date.now() < deadline)) throw new Error("Dispatch expired before the operation was verified.");
  }

  beginClick(): void { this.clicked = true; }

  dispose(): void {
    this.navigation?.removeEventListener("currententrychange", this.check);
    document.removeEventListener("visibilitychange", this.check);
  }
}

async function preparePrompt(dispatch: DispatchPayload, target: DispatchTarget): Promise<void> {
  const deadline = dispatch.expiresAt;
  const readComposer = (): ComposerElement | null => {
    target.require(deadline);
    return findComposer();
  };
  if (!await waitFor(readComposer, deadline)) {
    throw new Error(
      "ChatGPT composer did not appear before timeout. The user may be logged out, " +
      "an interstitial may be blocking the page, or ChatGPT's DOM may have changed."
    );
  }
  const readVerifiedComposer = (): ComposerElement | null => {
    const composer = readComposer();
    return composer && composerHasPrompt(composer, dispatch.prompt) ? composer : null;
  };
  const prefilled = await waitFor(readVerifiedComposer, Math.min(deadline, Date.now() + PREFILL_GRACE_MS));
  if (prefilled || readVerifiedComposer()) return;
  const composer = readComposer();
  if (!composer || readComposerText(composer) !== "") {
    throw new Error("No verified empty composer was available for prompt injection.");
  }
  // A tab activation may be known only to the worker. Its acknowledgement
  // does not extend the claim or authorize writing to a replacement editor.
  await requireAcknowledgementBy({ type: "check-insertion", dispatchId: dispatch.id }, deadline);
  const current = readComposer();
  if (current !== composer || readComposerText(composer) !== "") {
    if (current && composerHasPrompt(current, dispatch.prompt)) return;
    throw new Error("The empty composer changed while checking prompt insertion.");
  }
  insertPrompt(composer, dispatch.prompt, () => target.require(deadline));
  if (!await waitFor(readVerifiedComposer, Math.min(deadline, Date.now() + PROMPT_UPDATE_TIMEOUT_MS))) {
    throw new Error("Prompt injection failed; the composer did not contain the expected prompt.");
  }
}

function readReadySubmission(prompt: string): HTMLButtonElement | null {
  const composer = findComposer();
  if (!composer || !composerHasPrompt(composer, prompt) || !isModelSelectorEnabled(composer)) return null;
  const button = findSendButton(composer);
  return button && isSendButtonEnabled(button) ? button : null;
}

async function requireAcknowledgementBy(
  message: Extract<ContentMessage, { type: "check-insertion" | "confirm-dispatch" }>, deadline: number
): Promise<void> {
  let timer: number | undefined;
  try {
    const reply = await Promise.race([
      sendMessage(message),
      new Promise<never>((_, reject) => {
        timer = window.setTimeout(() => reject(new Error(`The ${message.type} reply timed out.`)),
          Math.max(0, deadline - Date.now()));
      })
    ]);
    if (reply?.ok !== true) throw new Error(reply?.error ?? `The ${message.type} acknowledgement was missing.`);
  } finally {
    clearTimeout(timer);
  }
}

interface CloseEvidence {
  pathname: string;
  deadline: number;
}

async function submitAndObserve(dispatch: DispatchPayload, target: DispatchTarget): Promise<CloseEvidence | null> {
  if (!await waitFor(() => {
    target.require(dispatch.expiresAt);
    return readReadySubmission(dispatch.prompt);
  }, dispatch.expiresAt)) {
    throw new Error("The expected prompt could not be verified with an enabled model selector and Send button before timeout.");
  }
  target.require(dispatch.expiresAt);
  const armed = await sendMessage({ type: "arm-dispatch", dispatchId: dispatch.id });
  if (!armed.ok) throw new Error(armed.error);
  if (!armed.dispatch || armed.dispatch.id !== dispatch.id || armed.dispatch.status !== "submitting" ||
    !Number.isFinite(armed.dispatch.expiresAt)) {
    throw new Error("A valid armed dispatch lease was missing.");
  }
  const deadline = armed.dispatch.expiresAt;
  target.require(deadline);

  // Arming crosses an asynchronous boundary. Never submit a stale composer or
  // prompt captured before the service worker replied, and never re-arm/retry.
  const ready = readReadySubmission(dispatch.prompt);
  if (!ready) {
    throw new Error("The expected prompt or enabled model/Send controls changed while arming; refusing to submit.");
  }
  const closeCheck = dispatch.autoClose
    ? createAutoCloseCheck(countStartedAssistantMessages())
    : null;
  // Invoke button-specific frontend handlers as well as the form's submit event.
  target.require(deadline);
  const confirmBy = Math.min(deadline, Date.now() + SUBMISSION_CONFIRM_TIMEOUT_MS);
  target.beginClick();
  ready.click();

  const submitted = await waitFor(() => {
    target.require(confirmBy);
    const composer = findComposer();
    if (!composer) return null;
    const button = findSendButton(composer);
    if (!isSubmissionConfirmed({
      composerPresent: true,
      composerHasExpectedPrompt: readComposerPromptMatch(composer, dispatch.prompt),
      sendButtonEnabled: button ? isSendButtonEnabled(button) : null
    })) return null;
    if (!closeCheck) return true;

    // Start in the DOM-confirming read itself. Even the next microtask can
    // finish streaming before the worker has persisted confirmation.
    const controller = new AbortController();
    const evidence = waitFor(() => target.check() ? closeCheck() : false, deadline, controller.signal)
      .catch(() => false); // Unreadable response evidence is not a failed submission.
    return { controller, evidence };
  }, confirmBy);
  if (!submitted) {
    throw new Error("Submission could not be confirmed after clicking the Send button.");
  }
  if (submitted === true) return null;
  const { controller, evidence } = submitted;
  try {
    await requireAcknowledgementBy({ type: "confirm-dispatch", dispatchId: dispatch.id }, deadline);
    const pathname = await evidence;
    return typeof pathname === "string" ? { pathname, deadline } : null;
  } finally {
    controller.abort();
  }
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
  const target = new DispatchTarget();
  try {
    const claim = await sendMessage({ type: "claim-dispatch", dispatchId });
    if (!claim.ok || !claim.dispatch) {
      throw new Error(claim.ok ? "Dispatch payload was missing." : claim.error);
    }
    dispatch = claim.dispatch;
    await preparePrompt(dispatch, target);
    target.require(dispatch.expiresAt);
    const evidence = dispatch.autoSubmit ? await submitAndObserve(dispatch, target) : null;
    const closeTab = evidence !== null && target.check() && location.pathname === evidence.pathname &&
      Date.now() < evidence.deadline;
    if (dispatch.autoSubmit && dispatch.autoClose && !closeTab) {
      console.error("[Share to ChatGPT] Submission succeeded, but safe closing could not be verified; leaving the tab open.");
    }
    const completed = await sendMessage({
      type: "complete-dispatch", dispatchId, closeTab,
      ...(closeTab && { closePath: evidence.pathname })
    });
    if (!completed.ok) throw new Error(completed.error);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (dispatch) await reportFailure(dispatchId, detail);
    else console.error(`[Share to ChatGPT] ${detail}`);
  } finally {
    target.dispose();
  }
}

if (typeof location !== "undefined") {
  const dispatchId = takeDispatchId();
  if (dispatchId) void runDispatch(dispatchId);
}
