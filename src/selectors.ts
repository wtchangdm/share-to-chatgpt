export type ComposerElement = HTMLTextAreaElement | HTMLElement;

const COMPOSER_SELECTORS = [
  'main form[data-chatgpt-composer] [data-composer-markdown][contenteditable="true"][role="textbox"]',
  'main form [contenteditable="true"][role="textbox"]',
  'main form textarea[name="prompt"]'
] as const;
const TURN_SELECTOR = '[data-turn-key]';
export const ASSISTANT_MESSAGE_SELECTOR =
  'main [data-chatgpt-conversation-selection-target] ' +
  `${TURN_SELECTOR} [data-markdown-text-style="assistant-message"]`;
export const RESPONSE_STOP_BUTTON_SELECTOR = 'button[type="button"][aria-label="Stop"]';
export const SEND_BUTTON_SELECTORS = ['button[type="submit"]'] as const;
export const OBSERVED_ATTRIBUTES = [
  "disabled", "aria-disabled", "contenteditable", "aria-label", "type",
  "data-markdown-text-style"
];

export function findObservationRoot(): Node {
  return document.querySelector("main") ?? document;
}

export function findComposer(): ComposerElement | null {
  for (const selector of COMPOSER_SELECTORS) {
    const element = document.querySelector(selector);
    if (element instanceof HTMLTextAreaElement ||
      (element instanceof HTMLElement && element.isContentEditable)) {
      return element;
    }
  }
  return null;
}

export function findComposerForm(composer: ComposerElement): HTMLFormElement | null {
  const form = composer.closest("form");
  return form instanceof HTMLFormElement ? form : null;
}

export function findSendButton(composer: ComposerElement): HTMLButtonElement | null {
  const button = findComposerForm(composer)?.querySelector(SEND_BUTTON_SELECTORS[0]);
  return button instanceof HTMLButtonElement ? button : null;
}

export function findResponseStopButton(composer: ComposerElement): HTMLButtonElement | null {
  const button = findComposerForm(composer)?.querySelector(RESPONSE_STOP_BUTTON_SELECTOR);
  return button instanceof HTMLButtonElement ? button : null;
}

export function isSendButtonEnabled(button: HTMLButtonElement): boolean {
  return !button.disabled && button.getAttribute("aria-disabled") !== "true";
}

export function readComposerText(composer: ComposerElement): string {
  return composer instanceof HTMLTextAreaElement
    ? composer.value
    : composer.innerText || composer.textContent || "";
}

export function countStartedAssistantMessages(): number {
  // A turn contains the user prompt as well as the response. Only assistant
  // markdown qualifies; message IDs are not assigned until streaming finishes.
  const turns = new Set<Element>();
  document.querySelectorAll(ASSISTANT_MESSAGE_SELECTOR).forEach((markdown) => {
    if (!markdown.textContent?.trim()) {
      return;
    }
    const turn = markdown.closest(TURN_SELECTOR);
    if (turn) {
      turns.add(turn);
    }
  });
  return turns.size;
}
