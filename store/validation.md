# Initial unlisted release preparation — validation record

Recorded September 27, 2026 for version 0.1.0, including the refined default prompt and automatic closing enabled by default. This is local preparation, not store approval or a complete live ChatGPT release sign-off.

## Artifact

- Archive: `release/share-to-chatgpt-0.1.0.zip` (generated, ignored by Git).
- SHA-256: `c939aa12c057f5bef1388835df4c66eebd544501a2146ca5847a317384c73ce4`.
- Contains 10 runtime files, with `manifest.json` at the root. No source maps, tests, development dependencies, privacy/store documents, or unrelated files.
- Rebuilding can change the archive hash; verify the actual archive selected for upload.

## Automated checks

Environment: macOS, Node.js v26.10.0, installed project dependencies, system `zip`/`unzip`. The README recommends Node.js LTS; this run used the existing Node installation and did not install or change dependencies.

- Packaging TDD: the regression test failed before implementation, then passed. It covers exact entries and file bytes, manifest resource inclusion, exclusion of unrelated files/source maps, replacement of stale archive entries, preservation of the previous archive on missing-file failure, and successful recovery.
- Default-prompt changes: focused Options tests demonstrated red → green for the exact wording and preservation of existing custom/empty prompts.
- Automatic-close default: focused prompt, Options, and background tests demonstrated red → green. Coverage includes absent settings, saved true/false, invalid values remaining disabled, no writes during loading, repeated reloads, reset, disabled automatic submission, and creation/arming of an auto-close dispatch with no saved settings.
- `npm run check`: passed TypeScript, ESLint, all 84 unit tests, and production build.
- `npm run package`: passed.
- `unzip -t release/share-to-chatgpt-0.1.0.zip`: passed; all 10 entries checked.
- `git diff --check`: passed.
- Earlier `npm run test:composer-browser`: passed 119 checks in isolated Chrome/147.0.0.0 before the default changes. Not rerun for this settings change; composer reading/insertion code is unchanged. This is not a signed-in ChatGPT test.

## Actual archive in isolated Chromium

Extracted the latest generated ZIP into a new temporary directory and loaded that directory as an unpacked extension in a fresh named browser session, without the user's profile or login state.

- Extension enabled with zero reported manifest/runtime errors.
- Real Options page loaded with the default prompt, cleanup on, submission on, and automatic closing on, without writing settings to storage.
- Saved automatic closing off through the UI; two reloads retained false in both the UI and actual extension storage.
- Saved automatic closing on with automatic submission off; reload preserved both choices and disabled the closing control. Re-enabling submission made the control available again.
- Removed only this test profile's settings, reloaded, and verified default-on behavior returned without writing settings.
- No Options page errors recorded. Test session closed and temporary extraction removed.
- Refreshed `store/screenshot-options.png` from this archive with default settings. It contains no assistant response or personal data.
- PNG dimensions verified and images visually inspected: icon 128×128 with transparent padding, promotion 440×280, Options screenshot 1280×800. Icon is unchanged from initial preparation. The promotional arrow was shifted 15 pixels right to center it between the two graphics without overlapping the left card; the PNG was regenerated from `store/promo.svg` in isolated Chromium and visually checked.

## Performance measurements

Separate from correctness checks, the unchanged observation/transition algorithms were measured before and after the automatic-close default change using bundled production code on the same macOS arm64 machine and Node v26.10.0:

| Command | Fixed method | Before → after median |
| --- | --- | --- |
| `npm run benchmark:auto-close-observation` | 20,000 warmup observations, seven samples × 200,000 observations per scenario | Streaming after response start: 11 → 11 ns/observation; awaiting response start: 3,170 → 3,205 ns/observation |
| `npm run benchmark:dispatch-policy` | 30,000 warmup transitions, seven samples × 300,000 transitions | Claim and arm: 27 → 27 ns/transition |

These fixtures measure per-operation cost, not live ChatGPT latency or the additional observation work caused by enabling closing for users without a saved preference.

## Remaining release gates

Chrome Web Store work is deferred. Repository commits and pushes do not authorize store upload, submission, or publication. Before resuming, rerun release validation against the then-current Chrome/ChatGPT frontend and recheck store requirements; this preparation record is not a future release sign-off.

- [blocked] Live ChatGPT regressions: no signed-in debugging session and authorized test tab were provided. Toolbar/context-menu/shortcut dispatch, live deep-link and fallback insertion, exactly-once submission, source-tab retention, failure paths, automatic closing/reopening, and live timings remain unverified in this preparation run. Follow `spec.md` before release; local fixtures do not replace this.
- [blocked] Public privacy-policy URL: the policy is prepared in `PRIVACY.md`, but no store policy URL has been selected or verified for signed-out public access. Pushing the repository does not configure the Chrome Web Store listing.
- [blocked] Developer account: no dashboard session was provided. Registration/payment, two-step verification, publisher identity, verified contact email, and intended regions require the publisher.
- [blocked] Store upload/review/publication: no store item was created and no package or image was uploaded. These external actions require explicit approval after the remaining gates are resolved. Review the prepared data declarations against the dashboard's current definitions before certifying them.

Default prompt text and the automatic-close default changed; dispatch transitions, closing conditions, and permissions are unchanged. Saved boolean closing preferences are preserved; missing values default on and invalid values remain off. No live ChatGPT conversations were created, no credentials were accessed, and remote debugging was not enabled on the user's profile.
