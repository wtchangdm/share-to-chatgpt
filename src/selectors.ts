export type ComposerElement = HTMLTextAreaElement | HTMLElement;

export const ASSISTANT_MESSAGE_SELECTOR = '[data-message-author-role="assistant"]';

export const SEND_BUTTON_SELECTORS = [
  'button[data-testid="send-button"]',
  'button[aria-label="Send prompt"]',
  'button[aria-label="Send message"]',
  'button[type="submit"]'
] as const;

function isComposerElement(element: Element | null): element is ComposerElement {
  return element instanceof HTMLTextAreaElement ||
    (element instanceof HTMLElement && element.isContentEditable);
}

export function findComposer(): ComposerElement | null {
  const primary = document.querySelector("#prompt-textarea");
  if (isComposerElement(primary)) {
    return primary;
  }

  const fallbacks = [
    'main form [contenteditable="true"][role="textbox"]',
    'main form textarea[name="prompt"]',
    'main form textarea',
    'form [contenteditable="true"][role="textbox"]',
    'form textarea[name="prompt"]'
  ];

  for (const selector of fallbacks) {
    const candidate = document.querySelector(selector);
    if (isComposerElement(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function findComposerForm(composer: ComposerElement): HTMLFormElement | null {
  const form = composer.closest("form");
  return form instanceof HTMLFormElement ? form : null;
}

export function findSendButton(composer: ComposerElement): HTMLButtonElement | null {
  const form = findComposerForm(composer);
  if (!form) {
    return null;
  }

  for (const selector of SEND_BUTTON_SELECTORS) {
    const candidate = form.querySelector(selector);
    if (candidate instanceof HTMLButtonElement) {
      return candidate;
    }
  }

  return null;
}

export function isSendButtonEnabled(button: HTMLButtonElement): boolean {
  return !button.disabled && button.getAttribute("aria-disabled") !== "true";
}

export function readComposerText(composer: ComposerElement): string {
  if (composer instanceof HTMLTextAreaElement) {
    return composer.value;
  }

  return composer.innerText || composer.textContent || "";
}

export function countStartedAssistantMessages(): number {
  return Array.from(document.querySelectorAll(ASSISTANT_MESSAGE_SELECTOR))
    .filter((message) => message.textContent?.trim()).length;
}
