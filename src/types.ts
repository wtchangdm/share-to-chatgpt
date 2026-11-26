export type OptionalTextPlacement = "prepend" | "append";

export interface Settings {
  optionalText: string;
  placement: OptionalTextPlacement;
  stripTrackingParameters: boolean;
  autoSubmit: boolean;
  autoClose: boolean;
}

export type DispatchStatus = "pending" | "claimed" | "submitting" | "confirmed";

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

export type ContentMessage = { dispatchId: string } & (
  | { type: "claim-dispatch" }
  | { type: "check-insertion" }
  | { type: "arm-dispatch" }
  | { type: "confirm-dispatch" }
  | { type: "complete-dispatch"; closeTab: boolean; closePath?: string }
  | { type: "fail-dispatch"; error: string }
);

export type CompleteDispatchMessage = Extract<ContentMessage, { type: "complete-dispatch" }>;

export type DispatchResponse =
  | { ok: true; dispatch?: DispatchPayload }
  | { ok: false; error: string };
