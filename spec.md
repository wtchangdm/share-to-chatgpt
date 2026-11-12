# Share to ChatGPT specification

## Purpose

Share a URL in a background ChatGPT tab, verify the prompt, and optionally submit and close after a conversation URL and response-start signal appear. Defaults combine the cleaned URL, two LF line breaks, and the [default prompt](#default-prompt); an empty Prompt sends only the URL.

## Supported interactions

### Toolbar button

Share the active tab URL through the [dispatch flow](#prompt-and-dispatch-flow), keeping the source tab active. Submission and [automatic closing](#submission-and-automatic-closing) follow saved settings.

### Link context menu

The **Send link to ChatGPT** menu item appears for links and follows the same workflow using `info.linkUrl` instead of the active page URL.

### Link-or-page shortcut

When invoked with `Command+B` on macOS or `Ctrl+B` on other platforms, the shortcut uses the resolved URL of a link hovered in the active page. If no link is hovered, it uses the current page URL instead. The command queries only `a[href]:hover` in the main frame at invocation time, recursively follows open shadow roots on the hovered element path, and chooses the deepest matching anchor before falling back to `document.location.href`. It does not inspect closed shadow roots or child frames. Injection failures produce a local console error and a red `!` badge on the active tab.

The shortcut is a suggested default, not a setting stored by the extension. Users can customize or disable it through `chrome://extensions/shortcuts`.

## Settings

Settings are stored under `settings` in `chrome.storage.local`.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `optionalText` | `string` | [Default prompt](#default-prompt) | The user-editable Prompt text added to the target URL; may be empty. |
| `placement` | `"prepend" \| "append"` | `"append"` | Whether Prompt text appears before or after the URL. |
| `stripTrackingParameters` | `boolean` | `true` | Whether known tracking parameters are removed before prompt construction. |
| `autoSubmit` | `boolean` | `true` | Whether the verified prompt is submitted automatically. |
| `autoClose` | `boolean` | `true` | Whether the target tab closes after ChatGPT assigns a canonical conversation URL and starts responding. Effective only when `autoSubmit` is enabled. |

Prompt construction trims surrounding whitespace, normalizes CRLF/CR to LF, and preserves internal line breaks, blank lines, and indentation:

- Empty Prompt: target URL only, cleaned if enabled.
- Prepend: `<Prompt> <URL>` (one space).
- Append: `<URL>\n\n<Prompt>` (two LF line breaks).

Loading never writes settings. Missing/invalid placement defaults to `"append"`; valid saved choices are preserved. Keep the `optionalText` storage key: missing/non-string values use the default prompt, while all saved strings—including empty or whitespace-only values—are preserved.

The Options **Reset to defaults** button immediately writes all current default settings under the existing `settings` key and updates every form field, including automatic-close availability. No separate Save is required. It replaces saved preferences and unsaved edits but leaves unrelated local storage and session dispatch state untouched. Repeated resets are safe. A failed write leaves the fields and saved preferences unchanged, reports a local error, and shows `Could not reset settings.`; success shows `Defaults restored.` for approximately two seconds.

`autoClose` defaults to on only when absent or undefined. Preserve saved booleans; other invalid values disable closing. Disabling automatic submission makes closing ineffective without changing its saved preference.

### Default prompt

```text
Read the linked page. Start with a brief summary of its main point, key findings, and significance.

Then add only analysis that materially improves my understanding. Consider what is established versus claimed, interpreted, or speculative; the strongest evidence and important limitations; meaningful counterarguments or missing context; and consequential, surprising, overstated, or easily misunderstood points. These are evaluation criteria, not required sections. Include a point only if it changes the takeaway, confidence in it, or understanding of how or why it matters.

Use reliable external sources when needed to verify a consequential claim or resolve an important gap, and cite sources used. Disclose material limits on access to the page rather than inventing its contents.

Briefly include personal relevance or a useful lesson when it adds something specific, using what you know about me without forcing a connection. Recommend the original or follow-up reading only when you can identify substantial value beyond this briefing.

Do not create or update memories or assumptions about me from this link or summary; base any memory or personal-context updates on personal information I provide in substantive follow-up discussion.

Keep the depth proportional to the material. Preserve central findings, essential explanations, and caveats that change the takeaway. Cut low-value or repetitive points rather than compressing useful explanations into dense prose.

Omit inapplicable categories, generic caveats, repeated conclusions, process preambles, and offers to continue. Do not manufacture false balance.
```

Memory guidance permits existing personal context but not new inferences from the article; follow-up must supply personal information, not merely another article question. It is not an enforced privacy boundary: the extension does not control Memory, reference chat history, or retention, and the link/summary remain in context. See [privacy guidance](README.md#privacy-and-compatibility).

### Tracking-parameter cleanup

Cleanup applies only to valid HTTP and HTTPS URLs and removes every occurrence of these exact, case-sensitive parameter names:

- [Google Analytics][google-analytics]: `utm_id`, `utm_source`, `utm_medium`, `utm_campaign`, `utm_source_platform`, `utm_term`, `utm_content`, `utm_creative_format`, `utm_marketing_tactic`
- Google advertising ([click IDs][google-click-ids], [iOS IDs][google-ios-ids], [`gad_*`][google-gad], [Merchant Center][google-merchant]): `gclid`, `dclid`, `gbraid`, `wbraid`, `gad_source`, `gad_campaignid`, `srsltid`
- [Meta][meta-click-id], [Microsoft Advertising][microsoft-click-id], [TikTok][tiktok-click-id], and [LinkedIn][linkedin-click-id]: `fbclid`, `msclkid`, `ttclid`, `li_fat_id`
- [Mailchimp][mailchimp-tracking]: `mc_cid`, `mc_eid`, `mc_tc`

Cleanup scans the raw query once and parses the full URL only after finding a listed candidate, to validate its protocol. It reconstructs changed URLs from the original string, preserving the order and byte representation of retained parameters and the fragment. URLs without a listed parameter, invalid URLs, and non-HTTP(S) URLs are returned unchanged. Generic names such as `ref`, `source`, or `campaign` are not inferred to be tracking because they can control page functionality.

Removing parameters can invalidate signatures or one-time tokens covering the query. Users can disable cleanup; the extension does not guess which URLs are signed.

[google-analytics]: https://support.google.com/analytics/answer/10917952
[google-click-ids]: https://support.google.com/analytics/answer/15612152
[google-ios-ids]: https://support.google.com/google-ads/answer/10417364
[google-gad]: https://support.google.com/google-ads/answer/16193746
[google-merchant]: https://support.google.com/merchants/answer/15191080
[meta-click-id]: https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/fbp-and-fbc/
[microsoft-click-id]: https://learn.microsoft.com/en-us/advertising/msa-help/hlp_ba_proc_microsoftclickid
[tiktok-click-id]: https://ads.tiktok.com/help/article/tiktok-click-id?lang=en
[linkedin-click-id]: https://www.linkedin.com/help/lms/answer/a5939261
[mailchimp-tracking]: https://mailchimp.com/developer/marketing/docs/e-commerce/

## Architecture

```text
src/
  background.ts       Service worker, commands, context menu, dispatch state, status, tab lifecycle
  content.ts          ChatGPT readiness, prompt verification/injection, submission
  diagnostics.ts      Data-safe failure titles for the extension action
  dispatch-policy.ts  Pure one-way dispatch transition policy
  hovered-link.ts     Invocation-time hovered-link lookup for the active page
  options-model.ts    Settings load/save behavior and UI state
  options.ts          Local settings UI bindings
  prompt.ts           Settings normalization, prompt construction, and dispatch URL
  selectors.ts        Isolated ChatGPT DOM selectors
  submission.ts       Pure submission-confirmation policy
  types.ts            Settings, dispatch, and message types
```

Framework-free; esbuild bundles three browser entry points into `dist/`.

`scripts/package.mjs` allowlists only `manifest.json` (ZIP root), `options.html`, `options.css`, three JavaScript bundles, and four manifest PNG icons. It replaces the versioned archive only on success, without changing runtime permissions or behavior. See [release preparation](AGENTS.md#chrome-web-store-release-preparation).

## Permissions

Permissions: `activeTab`, `contextMenus`, `scripting`, `storage`; host access: `https://chatgpt.com/*` only. The static content script runs there at `document_start` to capture the dispatch marker before application history changes. `scripting` uses temporary `activeTab` access only for the link-or-page command.

No all-sites permission, paid OpenAI API, ChatGPT `/backend-api/` access, or third-party telemetry. Minimum Chrome version and production build target: 120.

## Prompt and dispatch flow

1. The service worker reads the target URL and local settings, then applies enabled tracking-parameter cleanup before constructing the prompt.
2. It generates a random UUID and stores a `pending` dispatch in `chrome.storage.session` before navigation. The payload retains only the generated prompt, tab IDs, timestamps, transition status, and applicable automation flags; it does not duplicate the target URL or retain the source title.
3. It creates an inactive `about:blank` tab, persists the target tab binding and tab index, and only then navigates that tab to ChatGPT. This ordering prevents the content script from claiming a dispatch before its target binding is stored.
4. Navigate to `https://chatgpt.com/#share-to-chatgpt-dispatch=<UUID>`. The navigation URL has no query string and contains no shared URL or prompt.
5. The content script does nothing in ChatGPT tabs without this marker.
6. For a marked tab, it removes the hash with `history.replaceState` and claims the matching session payload through extension messaging.
7. The service worker verifies the sender's bound tab ID and changes the dispatch state to `claimed`.
8. The content script waits for the composer, directly inserts the prompt from the claimed extension-local session payload, and verifies the resulting composer state exactly.
9. If `autoSubmit` is disabled, the dispatch completes in the `claimed` state and the tab remains open.
10. If `autoSubmit` is enabled, the content script requests the `claimed → submitting` transition before invoking submission. When auto-close is enabled, the successful transition extends the dispatch expiry to approximately 120 seconds so conversation persistence or the response-completion fallback can be verified.
11. A successful or final failed dispatch removes its session payload and tab index. Closing the target tab also removes its state.

A dispatch can be claimed and armed only once. The state transition before submission favors a missed submission over a duplicated submission if execution is interrupted at the boundary.

The source action shows blue `…` during its latest dispatch, then green `✓` for about two seconds. Titles distinguish submitted from prefilled without URL/prompt data. Older dispatch results cannot overwrite newer status. Navigation clears status; timer clearing is best-effort because the service worker may stop.

## Readiness and time bounds

Readiness uses `MutationObserver` on `[data-app-shell-active-page="true"] main` (the document until that active main exists), rebinding whenever the active root changes, even if React retains the previous main in the DOM. It observes child/text changes and `disabled`, `aria-disabled`, `contenteditable`, `aria-label`, `type`, and `data-markdown-text-style`, including in-place Send-to-Stop changes. Bounded 250 ms polling covers URL-only changes and missed events; no fixed page-load sleep is used. Success, timeout, and reader failure all release observers and timers.

A pending or claimed dispatch expires approximately 15 seconds after creation. Arming an auto-close dispatch extends its expiry to approximately 120 seconds from that transition; other armed dispatches retain the original expiry. Expiration is checked on every dispatch message, at service-worker startup, and opportunistically before a new dispatch. Service-worker timers provide prompt cleanup while the worker remains active; correctness does not depend on exact timer delivery.

Current bounded phases are:

- Prompt injection verification: up to 3 seconds.
- Submission confirmation: up to 2 seconds.
- Conversation-persistence and assistant-response detection for auto-close: bounded by the extended dispatch lifetime of approximately 120 seconds from arming.

## Selector strategy

All ChatGPT selector logic is isolated in `src/selectors.ts`. Scope composer and assistant queries to `[data-app-shell-active-page="true"] main`: the current app shell retains inactive pages, including their composers and conversation content. Inactive pages must never supply prompt, submission, or response evidence. Without an active page, no composer or assistant response qualifies.

### Current-frontend compatibility policy

Target the currently observed frontend. Replace obsolete selectors, logic, tests, and documentation rather than retaining legacy branches or aliases. These selector listings describe today's integration, not a historical compatibility requirement. Keep fallbacks only for demonstrated current interactions or documented safety/recovery needs.

Preserve supported interactions, exact prompt verification, one-way dispatch, time bounds, privacy, and fail-closed behavior. Verify changes in a [live debug session](AGENTS.md#live-chatgpt-troubleshooting), including streaming and reopening early-closed conversations.

### Composer

Within the active main, in priority order:

1. `form[data-chatgpt-composer] [data-composer-markdown][contenteditable="true"][role="textbox"]`
2. `form [contenteditable="true"][role="textbox"]`
3. `form textarea[name="prompt"]`

All candidates stay inside a main-content form; no historical ID or page-wide form matching.

Read textarea values directly. The observed contenteditable editor represents input lines as direct `p` children, including empty paragraphs containing a terminal `br.ProseMirror-trailingBreak` placeholder. Read text nodes and hard `br` line breaks, ignore only that terminal placeholder, and join paragraphs with one LF. Flat text/`br` content from insertion uses the same reader. The current editor also creates inline URL spans identified by `text-link-href`, `data-appearance="inline-mention"`, `data-layout="inline-flow"`, and `data-breakable-url`. Read their label through plain or class-only span wrappers; ignore only a text-free `span[data-inline-url-icon][aria-hidden="true"][contenteditable="false"]` inside such a link. The label must exactly match `text-link-href`; mismatched or abbreviated labels are unverifiable. Plain or class-only spans also wrap ordinary input text. Do not use layout-dependent `innerText` for verification: it adds visual paragraph spacing that is not part of the prompt. Other unrecognized elements, span attributes, non-empty icons, or mixed paragraph structures are unverifiable and must not pass prompt checks.

### Send button

Use an enabled `button[type="submit"]` inside the composer's form, respecting `disabled` and `aria-disabled`. Do not depend on localized labels, historical test IDs, or page-wide “Send” text matching.

### Submission readiness

Before arming and again after the arming reply, require an enabled `button[type="button"][aria-label="Select ChatGPT model"]` in the composer's form, respecting both `disabled` and `aria-disabled`. The observed startup UI can expose an enabled Send button before the model selector appears or becomes enabled. Send alone is not sufficient readiness evidence. Wait within the existing dispatch deadline; do not add a fixed delay or retry a submission.

### Assistant response

Response markers:

```css
[data-app-shell-active-page="true"] main [data-chatgpt-conversation-selection-target] [data-turn-key] [data-markdown-text-style="assistant-message"]
button[type="button"][aria-label="Stop"] /* restricted to the composer's form */
```

Count each turn with non-empty assistant markdown once. User text, toolbar labels, empty placeholders, and turn existence alone do not qualify. Do not require finalized message IDs: the observed UI adds them only after streaming ends.

Only UUID-shaped `/c/<UUID>` paths count as persistence evidence. Temporary paths such as the observed `/c/local-chatgpt%3A<UUID>` and unrelated paths do not. With the composer observable, close when either condition holds:

- **Canonical path:** an enabled scoped Stop exists, or the non-empty assistant-turn count increases. The Stop fast path skips text scans; the count path also works when Stop is unrecognized.
- **No canonical path:** an observed enabled Stop disappears and a new non-empty assistant turn exists. A disabled but present Stop is not disappearance.

Otherwise leave the tab open at timeout. Latch non-empty response detection per dispatch; never retain response text. These UI signals do not guarantee server persistence or continued generation. Live validation must reopen the exact early-closed conversation and verify a non-empty response.

## Prompt insertion

After claiming the dispatch, wait for the composer within the dispatch deadline, then directly insert the prompt from the session payload:

- A textarea uses the native `HTMLTextAreaElement.prototype.value` setter and an `input` event.
- A contenteditable composer uses selection plus `document.execCommand("insertText")`.
- If native contenteditable insertion does not produce the expected value, the DOM insertion fallback gives the composer a paragraph node populated through the native `innerText` setter (which represents line breaks as `br` nodes), followed by an `input` event. Prompt text is never interpreted as HTML.

The composer is read back after insertion. Submission is forbidden unless its normalized text exactly equals the expected prompt. Comparison normalizes non-breaking spaces, CRLF line endings, and surrounding whitespace only; internal line breaks and blank lines must match. Collapsed or missing paragraphs do not qualify.

## Submission and automatic closing

Immediately before submission, the content script rechecks that:

1. The composer exists.
2. The expected prompt is present.
3. The scoped Send button exists.
4. The Send button and scoped model selector are enabled.
5. The dispatch was successfully armed by the service worker.

After the asynchronous arming reply, the script reacquires the composer, enabled model selector, and enabled Send control and verifies the exact prompt again. A change at that boundary fails closed without submitting, retrying, or arming a second time.

Invoke the verified Send control once with `button.click()` to preserve button-specific frontend logic and the form submit event. No `form.requestSubmit()`, direct-form fallback, click retry, or synthetic keyboard event.

Submission is confirmed when the composer remains observable and either no longer contains the expected prompt or its Send button becomes disabled. A temporarily missing composer is treated as uncertainty and does not confirm submission. Unreadable composer content is not evidence that the expected prompt was cleared; in that case only an observable disabled Send button can confirm submission.

With `autoClose` enabled, record the non-empty assistant-turn count before submission and follow the [response-signal policy](#assistant-response). On success, ask the service worker to close the target using `chrome.tabs.remove`; on timeout, leave it open. Skip response scans on the Stop fast path, while a temporary-path response is streaming, and entirely when auto-close is disabled.

## Failure behavior

The extension fails closed. It never intentionally submits an empty, stale, unverifiable, or duplicate prompt.

On final failure:

- Keep the ChatGPT tab open.
- Log a clear local console error.
- Show a red `!` badge on the target tab and on the source tab when that dispatch still owns the source's latest status.
- Set a concise per-tab extension-action title describing the failure category without including a URL, prompt, or underlying error detail.
- Remove consumed dispatch state.
- Do not retry submission.

Handle restricted-page shortcut injection, logged-out sessions, interstitials/challenges, missing composer, failed injection, missing/disabled Send, changed selectors, and closely timed dispatches.

A missing response-start marker or unverified auto-close condition after a confirmed submission is nonfatal: the extension logs a console error, consumes the completed dispatch, and leaves the tab open. It does not show a failure badge for a message that was already submitted.

## Security and privacy

- Until composer insertion, prompts, settings, and dispatch state are held only in local extension storage and memory. Dispatch payloads do not separately retain source titles or duplicate target URLs.
- The ChatGPT navigation URL has no query string or prompt. Its temporary dispatch hash contains only a random UUID and is removed immediately.
- Runtime messages are accepted only from `https://chatgpt.com/` tabs and are bound to the expected target tab ID.
- The constructed prompt is provided to the ChatGPT page's composer even with automatic submission disabled. ChatGPT may read or save drafts before Send; disabling submission is not a data-isolation boundary. No browsing data, prompt, or ChatGPT content is sent by the extension to any other service.
- Assistant message content is checked only for non-emptiness and is never stored.

## Manual regression checklist

Run the cases relevant to a change and report which cases were verified in the current build. The checklist records required coverage, not historical test status.

- Log in to `https://chatgpt.com` normally.
- On a non-ChatGPT page, click the toolbar button once.
- Confirm the original tab remains selected throughout.
- Confirm one background ChatGPT tab navigates to `https://chatgpt.com/#share-to-chatgpt-dispatch=<UUID>` without a query string or prompt in the navigation URL, removes the marker, inserts the page URL and configured Prompt into the composer, and submits one initial message.
- Confirm no Enter key or second click is needed and the ChatGPT tab remains open when auto-close is disabled. During startup, confirm an enabled Send does not trigger submission before the scoped model selector appears and is enabled.
- Right-click a link, choose **Send link to ChatGPT**, and confirm the linked URL—not the current page URL—is submitted.
- Hover over a link, press the configured shortcut, and confirm the linked URL—not the current page URL—is submitted.
- Press the shortcut without hovering a link and confirm the current page URL is submitted.
- Press the shortcut on a Chrome-restricted page and confirm no ChatGPT tab opens, a red `!` badge appears, and hovering the extension action reports that the shortcut is unavailable on that page.
- Change the shortcut through `chrome://extensions/shortcuts`, reload the extension, and confirm the new shortcut triggers the same link-or-page workflow.
- With link cleanup enabled, send a URL containing `utm_source`, `fbclid`, and an unrelated query parameter; verify the listed tracking parameters are absent while the unrelated parameter and fragment remain.
- Disable link cleanup, send the same URL, and verify it remains unchanged.
- Save prepend text in **Options**, send a page, and verify `text + space + cleaned URL`.
- Save append text, send a link, and verify `cleaned URL + two LF line breaks + text`.
- In Options, change and save every setting, make unsaved edits, then choose **Reset to defaults**. Confirm all fields return to current defaults, automatic closing is enabled, and reopening retains defaults without a separate Save. Repeat reset and confirm unrelated local data and active dispatches remain intact.
- In a fresh extension profile, confirm Options displays the default Prompt. Clear it, save, reopen Options, and confirm it stays empty and sharing sends only the URL. Existing custom prompts must also remain unchanged after reload.
- Save Prompt text with multiple paragraphs, blank lines, and single line breaks; verify they survive both prepend and append through native insertion and the DOM insertion fallback. In the current contenteditable editor, verify direct paragraphs, empty-paragraph placeholders, and inline URL labels/icons compare as logical text, without accepting mismatched link targets, missing blank lines, or collapsed text. Repeat with automatic submission disabled, then enabled, verifying one correctly formatted message and no collapsed paragraphs. If exact formatting cannot be verified, confirm the tab stays open without submission.
- Trigger two dispatches close together and verify each target tab submits its own prompt once.
- Log out of ChatGPT or block the composer, dispatch again, and confirm no prompt is submitted, the tab remains open, and a red `!` badge or error appears.
- Open an unrelated ChatGPT tab and confirm it does not auto-submit anything.
- Disable automatic submission and confirm the correct prompt is prefilled but not submitted.
- In a fresh profile, confirm automatic closing is checked. Save it off, reload Options, and confirm it remains off. Disable automatic submission and confirm the closing control is disabled without losing its saved preference. With automatic submission on and the default automatic closing on, confirm the background tab remains open on temporary paths such as `/c/local-chatgpt%3A<UUID>`, then closes after a canonical `/c/<UUID>` path appears while the enabled form-scoped Stop button is present, without waiting for assistant text or the full response. Reopen that exact conversation and verify it loads with a non-empty response.
- On the observed ChatGPT UI with a form-scoped contenteditable textbox and no composer ID, confirm one submission and automatic closing after a canonical `/c/<UUID>` path and new non-empty assistant markdown appear, even without a recognized Stop button or finalized message IDs. When the app retains an inactive home page or conversation, confirm only the active page supplies the composer and response evidence, and DOM observation follows active-page switches even when the old main remains connected.
- Confirm user text and empty assistant placeholders do not trigger closing; temporary conversation paths without a verified streaming-completion transition remain open.
- Reload the extension and confirm automation settings retain their saved values.

## Inherently fragile behavior

ChatGPT's composer markup, React/contenteditable behavior, test IDs, submission controls, and assistant-message attributes are not public APIs. Account-specific experiments, localization, login challenges, or future DOM changes can break these integrations.

Selector failures must remain narrow and fail closed. When ChatGPT changes its DOM, update `src/selectors.ts` using observed markup rather than adding broad page-wide text matching.
