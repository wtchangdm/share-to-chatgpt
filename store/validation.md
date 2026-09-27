# Initial unlisted release preparation — validation record

Recorded September 27, 2026 for version 0.1.0. This is local preparation, not store approval or a complete live ChatGPT release sign-off.

## Artifact

- Archive: `release/share-to-chatgpt-0.1.0.zip` (generated, ignored by Git).
- SHA-256: `abaefd2ec5cdab8ff08805046b63cff1627a589b7cbc5e697a357f20343229fe`.
- Contains 10 runtime files, with `manifest.json` at the root. No source maps, tests, development dependencies, privacy/store documents, or unrelated files.
- Rebuilding can change the archive hash; verify the actual archive selected for upload.

## Automated checks

Environment: macOS, Node.js v26.10.0, installed project dependencies, system `zip`/`unzip`. The README recommends Node.js LTS; this run used the existing Node installation and did not install or change dependencies.

- Packaging TDD: the new regression test failed because `scripts/package.mjs` did not exist, then passed after implementation.
- Packaging regression covers exact entries and file bytes, manifest resource inclusion, exclusion of unrelated files/source maps, replacement of stale archive entries, preservation of the previous archive on missing-file failure, and successful recovery.
- `npm run check`: passed TypeScript, ESLint, all 82 unit tests, and production build.
- `npm run test:composer-browser`: passed 119 checks in isolated Chrome/147.0.0.0, including native/fallback composer insertion and repeated/reset paths. This is not a signed-in ChatGPT test.
- `npm run package`: passed.
- `unzip -t release/share-to-chatgpt-0.1.0.zip`: passed; all 10 entries checked.
- PNG dimensions verified: icon 128×128 with transparent padding, promotion 440×280, Options screenshot 1280×800. All three images visually inspected.
- `git diff --check`: passed.

## Actual archive in isolated Chromium

Extracted the generated ZIP into a new temporary directory and loaded that directory as an unpacked extension in a fresh named browser session, without the user's profile or login state.

- Extension enabled with zero reported manifest/runtime errors.
- Real Options page loaded with the default prompt, cleanup on, submission on, and automatic closing off.
- Saved a synthetic prompt and disabled submission through the UI; reloading retained both and disabled the dependent automatic-close control.
- Saved an empty prompt and reloaded; it remained empty in both the UI and actual extension storage.
- Removed only this test profile's settings, reloaded, and verified defaults returned.
- No Options page errors recorded. Test sessions closed and temporary extraction removed.

Before the final grammar refinement, after the requested default-prompt wording update, the focused Options tests were first confirmed red (old wording), then green (all four tests). `npm run check`, packaging, and ZIP integrity checks passed again. The rebuilt ZIP was extracted and loaded in a fresh isolated Chromium session with zero manifest/runtime errors; the Options page displayed the new recommendation sentence. The screenshot was refreshed from that actual archive with default settings and contains no assistant response or personal data. Earlier persistence/reset and 119 composer checks above were performed before this text-only update; they were not rerun in the browser.

Prompt benchmark: `npm run benchmark:prompt`, Node v26.10.0 on darwin/arm64, bundled production code, 30,000 warmup operations per scenario and seven samples of 300,000 operations. Before → after medians for the final grammar refinement (ns/operation): URL-only 105 → 105; single-line 114 → 115; multiline 124 → 124. These fixed-input scenarios do not measure the default prompt's changed length; prompt-construction logic is unchanged. Timing is separate from correctness validation.

The final grammar refinement uses “recommend reading the original only if it adds substantial value beyond the summary.” Focused Options tests again demonstrated red → green; all 82 tests in `npm run check`, rebuilding the ZIP, and archive integrity checks passed. The artifact hash above identifies this latest archive. Browser checks and the screenshot predate this final text-only refinement; they were not repeated because no rendering, storage, insertion, or dispatch logic changed. The edited sentence is below the screenshot's visible textarea area.

## Remaining release gates

Chrome Web Store work is deferred. Repository commits and pushes do not authorize store upload, submission, or publication. Before resuming, rerun release validation against the then-current Chrome/ChatGPT frontend and recheck store requirements; this preparation record is not a future release sign-off.

- [blocked] Live ChatGPT regressions: no signed-in debugging session and authorized test tab were provided. Toolbar/context-menu/shortcut dispatch, live deep-link and fallback insertion, exactly-once submission, source-tab retention, failure paths, automatic closing/reopening, and live timings remain unverified in this preparation run. Follow `spec.md` before release; local fixtures do not replace this.
- [blocked] Public privacy-policy URL: the policy is prepared in `PRIVACY.md`, but no store policy URL has been selected or verified for signed-out public access. Pushing the repository does not configure the Chrome Web Store listing.
- [blocked] Developer account: no dashboard session was provided. Registration/payment, two-step verification, publisher identity, verified contact email, and intended regions require the publisher.
- [blocked] Store upload/review/publication: no store item was created and no package or image was uploaded. These external actions require explicit approval after the remaining gates are resolved. Review the prepared data declarations against the dashboard's current definitions before certifying them.

Only the default prompt text changed in extension runtime code; dispatch logic and permissions are unchanged. No live ChatGPT conversations were created, no credentials were accessed, and remote debugging was not enabled on the user's profile.
