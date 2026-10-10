import { DEFAULT_SETTINGS, normalizeSettings } from "./prompt";
import type { OptionalTextPlacement, Settings } from "./types";

const SETTINGS_KEY = "settings";

export interface OptionsFields {
  optionalText: { value: string };
  placement: { value: string };
  stripTrackingParameters: { checked: boolean };
  autoSubmit: { checked: boolean };
  autoClose: { checked: boolean; disabled: boolean };
  status: { textContent: string };
}

export interface SettingsStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

type ErrorReporter = (message: string, error: unknown) => void;
type ScheduleClear = (callback: () => void, delay: number) => unknown;

const defaultErrorReporter: ErrorReporter = (message, error) => {
  console.error(message, error);
};

export function syncAutoCloseAvailability(fields: OptionsFields): void {
  fields.autoClose.disabled = !fields.autoSubmit.checked;
}

function applySettings(fields: OptionsFields, settings: Settings): void {
  fields.optionalText.value = settings.optionalText;
  fields.placement.value = settings.placement;
  fields.stripTrackingParameters.checked = settings.stripTrackingParameters;
  fields.autoSubmit.checked = settings.autoSubmit;
  fields.autoClose.checked = settings.autoClose;
  syncAutoCloseAvailability(fields);
}

export async function resetOptions(
  fields: OptionsFields,
  storage: SettingsStorage,
  scheduleClear: ScheduleClear,
  reportError: ErrorReporter = defaultErrorReporter
): Promise<boolean> {
  try {
    await storage.set({ [SETTINGS_KEY]: { ...DEFAULT_SETTINGS } });
    applySettings(fields, DEFAULT_SETTINGS);
    fields.status.textContent = "Defaults restored.";
    scheduleClear(() => {
      fields.status.textContent = "";
    }, 2_000);
    return true;
  } catch (error) {
    fields.status.textContent = "Could not reset settings.";
    reportError("[Share to ChatGPT] Could not reset settings.", error);
    return false;
  }
}

export async function loadOptions(
  fields: OptionsFields,
  storage: SettingsStorage,
  reportError: ErrorReporter = defaultErrorReporter
): Promise<boolean> {
  try {
    const result = await storage.get(SETTINGS_KEY);
    const settings = normalizeSettings(result[SETTINGS_KEY] as Partial<Settings> | undefined);

    applySettings(fields, settings);
    return true;
  } catch (error) {
    syncAutoCloseAvailability(fields);
    fields.status.textContent = "Could not load settings.";
    reportError("[Share to ChatGPT] Could not load settings.", error);
    return false;
  }
}

export async function saveOptions(
  fields: OptionsFields,
  storage: SettingsStorage,
  scheduleClear: ScheduleClear,
  reportError: ErrorReporter = defaultErrorReporter
): Promise<boolean> {
  const placement: OptionalTextPlacement = fields.placement.value === "append"
    ? "append"
    : "prepend";

  try {
    await storage.set({
      [SETTINGS_KEY]: {
        optionalText: fields.optionalText.value,
        placement,
        stripTrackingParameters: fields.stripTrackingParameters.checked,
        autoSubmit: fields.autoSubmit.checked,
        autoClose: fields.autoClose.checked
      } satisfies Settings
    });

    fields.status.textContent = "Saved locally.";
    scheduleClear(() => {
      fields.status.textContent = "";
    }, 2_000);
    return true;
  } catch (error) {
    fields.status.textContent = "Could not save settings.";
    reportError("[Share to ChatGPT] Could not save settings.", error);
    return false;
  }
}
