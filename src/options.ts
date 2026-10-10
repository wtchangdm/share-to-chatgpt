import {
  loadOptions,
  resetOptions,
  saveOptions,
  syncAutoCloseAvailability,
  type OptionsFields
} from "./options-model";

interface BrowserOptionsFields extends OptionsFields {
  optionalText: HTMLTextAreaElement;
  placement: HTMLSelectElement;
  stripTrackingParameters: HTMLInputElement;
  autoSubmit: HTMLInputElement;
  autoClose: HTMLInputElement;
  status: HTMLOutputElement;
}

function getRequiredElement<T extends Element>(selector: string, type: { new(): T }): T {
  const element = document.querySelector(selector);
  if (!(element instanceof type)) {
    throw new Error(`Required options element is missing: ${selector}`);
  }
  return element;
}

function getOptionsFields(): BrowserOptionsFields {
  return {
    optionalText: getRequiredElement("#optional-text", HTMLTextAreaElement),
    placement: getRequiredElement("#placement", HTMLSelectElement),
    stripTrackingParameters: getRequiredElement(
      "#strip-tracking-parameters",
      HTMLInputElement
    ),
    autoSubmit: getRequiredElement("#auto-submit", HTMLInputElement),
    autoClose: getRequiredElement("#auto-close", HTMLInputElement),
    status: getRequiredElement("#status", HTMLOutputElement)
  };
}

const fields = getOptionsFields();
fields.autoSubmit.addEventListener("change", () => {
  syncAutoCloseAvailability(fields);
});

const form = getRequiredElement("#settings-form", HTMLFormElement);
form.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveOptions(fields, chrome.storage.local, window.setTimeout.bind(window));
});

const resetButton = getRequiredElement("#reset-settings", HTMLButtonElement);
resetButton.addEventListener("click", () => {
  void resetOptions(fields, chrome.storage.local, window.setTimeout.bind(window));
});

void loadOptions(fields, chrome.storage.local);
