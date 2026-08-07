import type { DispatchPayload } from "./types";

export const DISPATCH_STORAGE_PREFIX = "dispatch:";

export type DispatchTransition =
  | { ok: true; dispatch: DispatchPayload }
  | { ok: false; error: string };

function belongsToTab(dispatch: DispatchPayload, tabId: number): boolean {
  return dispatch.targetTabId === undefined || dispatch.targetTabId === tabId;
}

export function claimDispatch(
  dispatch: DispatchPayload,
  tabId: number
): DispatchTransition {
  if (!belongsToTab(dispatch, tabId)) {
    return { ok: false, error: "Dispatch belongs to a different tab." };
  }
  if (dispatch.status !== "pending") {
    return { ok: false, error: "Dispatch was already claimed." };
  }

  return {
    ok: true,
    dispatch: {
      ...dispatch,
      targetTabId: tabId,
      status: "claimed"
    }
  };
}

export function armDispatch(
  dispatch: DispatchPayload,
  tabId: number
): DispatchTransition {
  if (!belongsToTab(dispatch, tabId)) {
    return { ok: false, error: "Dispatch belongs to a different tab." };
  }
  if (dispatch.status !== "claimed") {
    return { ok: false, error: "Dispatch is not ready to submit." };
  }

  return {
    ok: true,
    dispatch: {
      ...dispatch,
      targetTabId: tabId,
      status: "submitting"
    }
  };
}

export function canCompleteDispatch(dispatch: DispatchPayload): boolean {
  return dispatch.status === "submitting" ||
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
