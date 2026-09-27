export type SubmissionSnapshot =
  | { composerPresent: false }
  | {
    composerPresent: true;
    composerHasExpectedPrompt: boolean | null;
    sendButtonEnabled: boolean | null;
  };

export function isSubmissionConfirmed(snapshot: SubmissionSnapshot): boolean {
  if (!snapshot.composerPresent) {
    return false;
  }

  return snapshot.composerHasExpectedPrompt === false || snapshot.sendButtonEnabled === false;
}
