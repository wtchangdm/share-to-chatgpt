export const DEFAULT_ACTION_TITLE = "Send this page to ChatGPT";

const FAILURE_TITLE = "Share to ChatGPT failed; see the extension console";

export function getFailureActionTitle(error: string): string {
  const normalized = error.toLowerCase();

  if (normalized.includes("cannot access") || normalized.includes("shortcut target")) {
    return "Share to ChatGPT: shortcut unavailable on this page";
  }
  if (normalized.includes("composer did not appear") || normalized.includes("composer unavailable")) {
    return "Share to ChatGPT: ChatGPT composer unavailable";
  }
  if (normalized.includes("prompt injection") || normalized.includes("expected prompt")) {
    return "Share to ChatGPT: prompt verification failed";
  }
  if (normalized.includes("send button")) {
    return "Share to ChatGPT: Send button unavailable";
  }
  if (normalized.includes("submission")) {
    return "Share to ChatGPT: submission could not be confirmed";
  }
  if (normalized.includes("timed out") || normalized.includes("expired")) {
    return "Share to ChatGPT: dispatch timed out";
  }
  if (normalized.includes("open chatgpt")) {
    return "Share to ChatGPT: could not open ChatGPT";
  }

  return FAILURE_TITLE;
}
