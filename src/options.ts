import { normalizeSettings } from "./prompt";
import type { OptionalTextPlacement, Settings } from "./types";

const SETTINGS_KEY = "settings";

function syncAutoCloseAvailability(): void {
  const autoSubmit = getRequiredElement("#auto-submit", HTMLInputElement);
  const autoClose = getRequiredElement("#auto-close", HTMLInputElement);
  autoClose.disabled = !autoSubmit.checked;
}

function getRequiredElement<T extends Element>(selector: string, type: { new(): T }): T {
  const element = document.querySelector(selector);
  if (!(element instanceof type)) {
    throw new Error(`Required options element is missing: ${selector}`);
  }
  return element;
}

async function loadSettings(): Promise<void> {
  const optionalText = getRequiredElement("#optional-text", HTMLTextAreaElement);
  const placement = getRequiredElement("#placement", HTMLSelectElement);
  const autoSubmit = getRequiredElement("#auto-submit", HTMLInputElement);
  const autoClose = getRequiredElement("#auto-close", HTMLInputElement);
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  const settings = normalizeSettings(result[SETTINGS_KEY] as Partial<Settings> | undefined);

  optionalText.value = settings.optionalText;
  placement.value = settings.placement;
  autoSubmit.checked = settings.autoSubmit;
  autoClose.checked = settings.autoClose;
  syncAutoCloseAvailability();
}

async function saveSettings(event: SubmitEvent): Promise<void> {
  event.preventDefault();

  const optionalText = getRequiredElement("#optional-text", HTMLTextAreaElement);
  const placement = getRequiredElement("#placement", HTMLSelectElement);
  const autoSubmit = getRequiredElement("#auto-submit", HTMLInputElement);
  const autoClose = getRequiredElement("#auto-close", HTMLInputElement);
  const status = getRequiredElement("#status", HTMLOutputElement);
  const placementValue: OptionalTextPlacement = placement.value === "append"
    ? "append"
    : "prepend";

  await chrome.storage.local.set({
    [SETTINGS_KEY]: {
      optionalText: optionalText.value,
      placement: placementValue,
      autoSubmit: autoSubmit.checked,
      autoClose: autoClose.checked
    } satisfies Settings
  });

  status.textContent = "Saved locally.";
  window.setTimeout(() => {
    status.textContent = "";
  }, 2_000);
}

const autoSubmit = getRequiredElement("#auto-submit", HTMLInputElement);
autoSubmit.addEventListener("change", syncAutoCloseAvailability);

const form = getRequiredElement("#settings-form", HTMLFormElement);
form.addEventListener("submit", (event) => {
  void saveSettings(event);
});

void loadSettings();
