import type { DispatchPayload } from "./types";

export const DISPATCH_STORAGE_PREFIX = "dispatch:";

export type DispatchTransition =
  | { ok: true; dispatch: DispatchPayload }
  | { ok: false; error: string };

function advance(
  dispatch: DispatchPayload, tabId: number, ready: boolean, status: DispatchPayload["status"], error: string
): DispatchTransition {
  if (dispatch.targetTabId !== tabId) return { ok: false, error: "Dispatch belongs to a different tab." };
  if (!ready) return { ok: false, error };
  return { ok: true, dispatch: { ...dispatch, status } };
}

export function claimDispatch(dispatch: DispatchPayload, tabId: number): DispatchTransition {
  return advance(dispatch, tabId, dispatch.status === "pending", "claimed", "Dispatch was already claimed.");
}

export function armDispatch(dispatch: DispatchPayload, tabId: number): DispatchTransition {
  return advance(dispatch, tabId, dispatch.status === "claimed" && dispatch.autoSubmit,
    "submitting", "Dispatch is not ready to submit.");
}

export function confirmDispatch(dispatch: DispatchPayload, tabId: number): DispatchTransition {
  return advance(dispatch, tabId, dispatch.status === "submitting" && dispatch.autoSubmit && dispatch.autoClose,
    "confirmed", "Dispatch is not awaiting submission confirmation.");
}

export function canCompleteDispatch(dispatch: DispatchPayload): boolean {
  return (dispatch.status === "confirmed" && dispatch.autoSubmit && dispatch.autoClose) ||
    (dispatch.status === "submitting" && dispatch.autoSubmit && !dispatch.autoClose) ||
    (dispatch.status === "claimed" && !dispatch.autoSubmit);
}

export function findExpiredDispatches(
  entries: Record<string, unknown>,
  now: number
): DispatchPayload[] {
  return Object.entries(entries)
    .filter(([key, value]) => key.startsWith(DISPATCH_STORAGE_PREFIX) &&
      typeof value === "object" && value !== null &&
      "expiresAt" in value && typeof value.expiresAt === "number" &&
      value.expiresAt <= now)
    .map(([, value]) => value as DispatchPayload);
}
