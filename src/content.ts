import { isChatGPTConversationUrl } from "./prompt";
import {
  findComposer,
  findComposerForm,
  findSendButton,
  isSendButtonEnabled,
  readComposerText,
  type ComposerElement
} from "./selectors";
import type { ContentMessage, DispatchPayload, DispatchResponse } from "./types";

const MARKER_PREFIX = "#share-to-chatgpt-dispatch=";
const PREFILL_GRACE_MS = 4_000;
const PROMPT_UPDATE_TIMEOUT_MS = 3_000;
const SUBMISSION_CONFIRM_TIMEOUT_MS = 2_000;
const CONVERSATION_URL_TIMEOUT_MS = 5_000;

function takeDispatchId(): string | null {
  if (!location.hash.startsWith(MARKER_PREFIX)) {
    return null;
  }

  const encodedId = location.hash.slice(MARKER_PREFIX.length);
  let dispatchId: string;
  try {
    dispatchId = decodeURIComponent(encodedId);
  } catch {
    return null;
  }

  history.replaceState(history.state, "", `${location.pathname}${location.search}`);
  return dispatchId;
}

function normalizeComposerText(text: string): string {
  return text
    .replaceAll("\u00a0", " ")
    .replaceAll("\r\n", "\n")
    .trim();
}

function composerHasPrompt(composer: ComposerElement, expectedPrompt: string): boolean {
  return normalizeComposerText(readComposerText(composer)) ===
    normalizeComposerText(expectedPrompt);
}

function waitFor<T>(readValue: () => T | null, deadline: number): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false;

    const finish = (value: T | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      observer.disconnect();
      clearInterval(intervalId);
      clearTimeout(timeoutId);
      resolve(value);
    };

    const check = (): void => {
      if (Date.now() >= deadline) {
        finish(null);
        return;
      }

      const value = readValue();
      if (value !== null) {
        finish(value);
      }
    };

    const observer = new MutationObserver(check);
    observer.observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["disabled", "aria-disabled", "contenteditable"],
      characterData: true
    });
    const intervalId = window.setInterval(check, 250);
    const timeoutId = window.setTimeout(() => finish(null), Math.max(0, deadline - Date.now()));
    check();
  });
}

async function sendMessage(message: ContentMessage): Promise<DispatchResponse> {
  return await chrome.runtime.sendMessage(message) as DispatchResponse;
}

function setTextareaValue(textarea: HTMLTextAreaElement, prompt: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value"
  )?.set;

  if (!setter) {
    throw new Error("The native textarea value setter is unavailable.");
  }

  setter.call(textarea, prompt);
  textarea.dispatchEvent(new InputEvent("input", {
    bubbles: true,
    composed: true,
    data: prompt,
    inputType: "insertText"
  }));
}

function setContentEditableValue(composer: HTMLElement, prompt: string): void {
  composer.focus({ preventScroll: true });

  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(composer);
  selection?.removeAllRanges();
  selection?.addRange(range);

  const inserted = document.execCommand("insertText", false, prompt);
  if (!inserted || !composerHasPrompt(composer, prompt)) {
    const paragraph = document.createElement("p");
    paragraph.textContent = prompt;
    composer.replaceChildren(paragraph);
    composer.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      composed: true,
      data: prompt,
      inputType: "insertText"
    }));
  }
}

function insertPrompt(composer: ComposerElement, prompt: string): void {
  if (composer instanceof HTMLTextAreaElement) {
    setTextareaValue(composer, prompt);
    return;
  }

  setContentEditableValue(composer, prompt);
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

async function reportFailure(dispatchId: string, error: string): Promise<void> {
  console.error(`[Share to ChatGPT] ${error}`);
  try {
    await sendMessage({ type: "fail-dispatch", dispatchId, error });
  } catch (messageError) {
    console.error("[Share to ChatGPT] Could not report the failure:", messageError);
  }
}

async function runDispatch(dispatchId: string): Promise<void> {
  let dispatch: DispatchPayload | undefined;

  try {
    const claim = await sendMessage({ type: "claim-dispatch", dispatchId });
    if (!claim.ok || !claim.dispatch) {
      throw new Error(claim.ok ? "Dispatch payload was missing." : claim.error);
    }
    const claimedDispatch = claim.dispatch;
    dispatch = claimedDispatch;

    const deadline = claimedDispatch.expiresAt;
    const composer = await waitFor(findComposer, deadline);
    if (!composer) {
      throw new Error(
        "ChatGPT composer did not appear before timeout. The user may be logged out, " +
        "an interstitial may be blocking the page, or ChatGPT's DOM may have changed."
      );
    }

    const prefilled = await waitFor(() => {
      const currentComposer = findComposer();
      return currentComposer && composerHasPrompt(currentComposer, claimedDispatch.prompt)
        ? currentComposer
        : null;
    }, Math.min(deadline, Date.now() + PREFILL_GRACE_MS));

    if (!prefilled) {
      const currentComposer = findComposer();
      if (!currentComposer) {
        throw new Error("The ChatGPT composer disappeared before prompt injection.");
      }

      insertPrompt(currentComposer, claimedDispatch.prompt);
      const updated = await waitFor(() => {
        const updatedComposer = findComposer();
        return updatedComposer && composerHasPrompt(updatedComposer, claimedDispatch.prompt)
          ? updatedComposer
          : null;
      }, Math.min(deadline, Date.now() + PROMPT_UPDATE_TIMEOUT_MS));
      if (!updated) {
        throw new Error("Prompt injection failed; the composer did not contain the expected prompt.");
      }
    }

    if (!claimedDispatch.autoSubmit) {
      const completed = await sendMessage({
        type: "complete-dispatch",
        dispatchId,
        closeTab: false
      });
      if (!completed.ok) {
        throw new Error(completed.error);
      }
      return;
    }

    const ready = await waitFor(() => {
      const currentComposer = findComposer();
      if (!currentComposer || !composerHasPrompt(currentComposer, claimedDispatch.prompt)) {
        return null;
      }
      const sendButton = findSendButton(currentComposer);
      return sendButton && isSendButtonEnabled(sendButton)
        ? { composer: currentComposer, button: sendButton }
        : null;
    }, deadline);

    if (!ready) {
      throw new Error(
        "The expected prompt could not be verified with an enabled Send button before timeout."
      );
    }

    const armed = await sendMessage({ type: "arm-dispatch", dispatchId });
    if (!armed.ok) {
      throw new Error(armed.error);
    }

    submitPrompt(ready.composer, ready.button);

    const submitted = await waitFor(() => {
      const currentComposer = findComposer();
      if (!currentComposer || !composerHasPrompt(currentComposer, claimedDispatch.prompt)) {
        return true;
      }
      const currentButton = findSendButton(currentComposer);
      return currentButton && !isSendButtonEnabled(currentButton) ? true : null;
    }, Math.min(deadline, Date.now() + SUBMISSION_CONFIRM_TIMEOUT_MS));

    if (!submitted) {
      throw new Error("Submission could not be confirmed after invoking the composer form.");
    }

    let closeTab = false;
    if (claimedDispatch.autoClose) {
      const conversationReady = await waitFor(
        () => isChatGPTConversationUrl(location.href) ? true : null,
        Math.min(deadline - 500, Date.now() + CONVERSATION_URL_TIMEOUT_MS)
      );
      closeTab = conversationReady === true;
      if (!closeTab) {
        console.error(
          "[Share to ChatGPT] Submission succeeded, but the conversation URL did not appear " +
          "before timeout; leaving the tab open."
        );
      }
    }

    const completed = await sendMessage({
      type: "complete-dispatch",
      dispatchId,
      closeTab
    });
    if (!completed.ok) {
      throw new Error(completed.error);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (dispatch) {
      await reportFailure(dispatchId, detail);
    } else {
      console.error(`[Share to ChatGPT] ${detail}`);
    }
  }
}

const dispatchId = takeDispatchId();
if (dispatchId) {
  void runDispatch(dispatchId);
}
