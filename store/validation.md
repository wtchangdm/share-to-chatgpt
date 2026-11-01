# Initial unlisted release — historical validation

Recorded September 27, 2026 for version 0.1.0: refined default prompt and default-on automatic closing. Local preparation only, not store approval or complete live ChatGPT sign-off.

## Artifact

- `release/share-to-chatgpt-0.1.0.zip` (generated, Git-ignored).
- SHA-256: `c939aa12c057f5bef1388835df4c66eebd544501a2146ca5847a317384c73ce4`.
- 10 runtime files; root `manifest.json`; no source maps, tests, development dependencies, privacy/store documents, or unrelated files.
- Rebuilds may change the hash; verify the archive selected for upload.

## Automated checks

Environment: macOS, Node.js v26.10.0, installed dependencies, system `zip`/`unzip`. Used existing Node rather than README-recommended LTS; no dependencies installed or changed.

- **Packaging TDD:** red → green; exact entries/bytes, manifest resources, unrelated-file/source-map exclusion, stale-entry replacement, previous-archive preservation on missing-file failure, and recovery.
- **Default-prompt TDD:** focused Options tests red → green for exact wording and preserved custom/empty prompts.
- **Closing-default TDD:** focused prompt/Options/background tests red → green; absent settings, saved true/false, invalid values disabled, read-only loading, repeated reloads, reset, disabled submission, and creation/arming with no saved settings.
- **Passed:** `npm run check` (TypeScript, ESLint, 84 unit tests, production build); `npm run package`; `unzip -t release/share-to-chatgpt-0.1.0.zip` (all 10 entries); `git diff --check`.
- **Earlier only:** `npm run test:composer-browser` passed 119 isolated Chrome/147.0.0.0 checks before default changes. Not rerun: composer reading/insertion unchanged. Not signed-in ChatGPT validation.

## Extracted archive in isolated Chromium

Loaded the latest ZIP's fresh temporary extraction as an unpacked extension in a fresh named session, without the user's profile/login:

- Enabled extension; zero reported manifest/runtime errors or Options errors.
- Real Options showed the default prompt and cleanup/submission/closing on without writing settings.
- Saved closing off through the UI; two reloads retained false in UI and storage.
- Saved closing on/submission off; reload preserved both and disabled the closing control. Re-enabling submission restored the control.
- Removed only test-profile settings; reload restored default-on without writes. Closed the session and removed extraction.
- Refreshed `store/screenshot-options.png` from this archive with defaults, no response/personal data.
- Verified dimensions and appearance: icon 128×128 with transparent padding, promotion 440×280 (regenerated from `store/promo.svg`), Options screenshot 1280×800.

## Performance measurements

Separate from correctness: bundled production code, same macOS arm64 machine and Node v26.10.0, before/after the closing-default change; observation/transition algorithms unchanged.

| Command | Fixed method | Before → after median |
| --- | --- | --- |
| `npm run benchmark:auto-close-observation` | 20,000 warmup observations, seven samples × 200,000 observations per scenario | Streaming after response start: 11 → 11 ns/observation; awaiting response start: 3,170 → 3,205 ns/observation |
| `npm run benchmark:dispatch-policy` | 30,000 warmup transitions, seven samples × 300,000 transitions | Claim and arm: 27 → 27 ns/transition |

Per-operation fixtures do not measure live latency or extra observation work from enabling closing without a saved preference.

## Remaining release gates

Store work is deferred. Commits/pushes do not authorize upload, submission, or publication. Before resuming, rerun release validation against the then-current Chrome/ChatGPT frontend and recheck store requirements; this record is not future sign-off.

- **Blocked — live ChatGPT:** no signed-in debugging session or authorized test tab. Unverified: toolbar/context-menu/shortcut dispatch, live deep-link/fallback insertion, exactly-once submission, source-tab retention, failures, closing/reopening, and timings. Run [manual regressions](../spec.md#manual-regression-checklist); fixtures are insufficient.
- **Blocked — public policy:** `PRIVACY.md` prepared, but no store policy URL selected or verified signed out. A repository push does not configure the listing.
- **Blocked — publisher account:** no dashboard session. Publisher must resolve registration/payment, two-step verification, identity, verified email, and regions.
- **Blocked — store actions:** no item created or package/images uploaded. Explicit approval required after other gates; review declarations against current dashboard definitions before certification.

Only default prompt text and closing default changed; transitions, closing conditions, and permissions did not. Saved closing booleans remain; missing defaults on, invalid stays off. No live conversations created, credentials accessed, or remote debugging enabled on the user's profile.
