import type { Settings } from "./types";

export const DEFAULT_SETTINGS: Settings = {
  optionalText: "",
  placement: "prepend",
  autoSubmit: true,
  autoClose: false
};

const CHATGPT_BASE_URL = "https://chatgpt.com/";

export function normalizeSettings(value: Partial<Settings> | undefined): Settings {
  return {
    optionalText: typeof value?.optionalText === "string" ? value.optionalText : "",
    placement: value?.placement === "append" ? "append" : "prepend",
    autoSubmit: value?.autoSubmit !== false,
    autoClose: value?.autoClose === true
  };
}

export function buildPrompt(
  url: string,
  settings: Pick<Settings, "optionalText" | "placement">
): string {
  const optionalText = settings.optionalText
    .trim()
    .replace(/\s*[\r\n]+\s*/g, " ");
  if (!optionalText) {
    return url;
  }

  return settings.placement === "append"
    ? `${url} ${optionalText}`
    : `${optionalText} ${url}`;
}

export function buildChatGPTUrl(prompt: string, dispatchId?: string): string {
  const deepLink = `${CHATGPT_BASE_URL}?prompt=${encodeURIComponent(prompt)}`;
  return dispatchId
    ? `${deepLink}#share-to-chatgpt-dispatch=${encodeURIComponent(dispatchId)}`
    : deepLink;
}
