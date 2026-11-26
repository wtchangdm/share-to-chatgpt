import {
  createOptionsActions,
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
const saveButton = getRequiredElement("#save-settings", HTMLButtonElement);
const resetButton = getRequiredElement("#reset-settings", HTMLButtonElement);
const retryButton = getRequiredElement("#retry-load", HTMLButtonElement);
const actions = createOptionsActions(fields, chrome.storage.local, window.setTimeout.bind(window), (state) => {
  const locked = state !== "ready";
  fields.optionalText.disabled = locked;
  fields.placement.disabled = locked;
  fields.stripTrackingParameters.disabled = locked;
  fields.autoSubmit.disabled = locked;
  fields.autoClose.disabled = locked || !fields.autoSubmit.checked;
  saveButton.disabled = locked;
  resetButton.disabled = state === "busy";
  retryButton.hidden = state !== "unavailable";
});

fields.autoSubmit.addEventListener("change", () => {
  syncAutoCloseAvailability(fields);
});

const form = getRequiredElement("#settings-form", HTMLFormElement);
form.addEventListener("submit", (event) => {
  event.preventDefault();
  void actions.save();
});
resetButton.addEventListener("click", () => { void actions.reset(); });
retryButton.addEventListener("click", () => { void actions.load(); });

void actions.load();
