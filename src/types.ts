export type OptionalTextPlacement = "prepend" | "append";

export interface Settings {
  optionalText: string;
  placement: OptionalTextPlacement;
  stripTrackingParameters: boolean;
  autoSubmit: boolean;
  autoClose: boolean;
}

export type DispatchStatus = "pending" | "claimed" | "submitting";

export interface DispatchPayload {
  id: string;
  prompt: string;
  sourceTabId?: number;
  targetTabId?: number;
  createdAt: number;
  expiresAt: number;
  status: DispatchStatus;
  autoSubmit: boolean;
  autoClose: boolean;
}

export interface ClaimDispatchMessage {
  type: "claim-dispatch";
  dispatchId: string;
}

export interface ArmDispatchMessage {
  type: "arm-dispatch";
  dispatchId: string;
}

export interface CompleteDispatchMessage {
  type: "complete-dispatch";
  dispatchId: string;
  closeTab: boolean;
}

export interface FailDispatchMessage {
  type: "fail-dispatch";
  dispatchId: string;
  error: string;
}

export type ContentMessage =
  | ClaimDispatchMessage
  | ArmDispatchMessage
  | CompleteDispatchMessage
  | FailDispatchMessage;

export type DispatchResponse =
  | { ok: true; dispatch?: DispatchPayload }
  | { ok: false; error: string };
