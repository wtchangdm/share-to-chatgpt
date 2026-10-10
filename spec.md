# Share to ChatGPT specification

## Purpose

Replace the foreground-interrupting bookmarklet workflow with a local Chrome extension that opens ChatGPT in a background tab, safely prefills the expected prompt, and optionally submits and closes the tab after ChatGPT assigns a canonical conversation URL and starts responding.

The original bookmarklet workflow is:

```js
javascript:(()=>{window.open(`https://chatgpt.com/?prompt=${encodeURIComponent(location.href)}`,"_blank","noopener,noreferrer")})()
```

With default settings, the shared prompt is the target URL after the conservative tracking-parameter cleanup defined below, two LF line breaks (one blank line), and the [default analysis text](#default-prompt). A URL without a listed tracking parameter remains byte-for-byte unchanged. When the Prompt setting is empty, only the URL is sent, and the ChatGPT deep link is:

```text
https://chatgpt.com/?prompt=<encoded cleaned target URL>
```

## Supported interactions

### Toolbar button

1. Read the active tab URL.
2. Construct the prompt from the URL and saved settings.
3. Create an inactive `about:blank` tab, bind its tab ID to the dispatch, and then navigate it to ChatGPT.
4. Keep the original tab active.
5. Verify or inject the prompt in the ChatGPT composer.
6. Submit when automatic submission is enabled.
7. Optionally close the ChatGPT tab after the temporary conversation path changes to a canonical `/c/<UUID>` path and either an enabled form-scoped Stop button or new non-empty assistant markdown indicates that a response started. If no canonical path is observed, completed streaming is the fail-safe fallback.

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

A blank Prompt value produces only the cleaned or original target URL. Non-empty Prompt text before the URL is separated from it by one space. When placed after the URL, it is separated by two LF line breaks (one blank line): `<URL>\n\n<Prompt>`. Surrounding whitespace is trimmed, but internal line breaks, blank lines, and indentation are preserved. CRLF and CR line endings are normalized to LF, not spaces.

Placement defaults to `"append"` when missing or invalid; existing saved `"prepend"` and `"append"` choices are preserved without writes on load.

The storage key remains `optionalText` for compatibility with saved settings. Missing or non-string values use the default prompt; existing string values, including empty or whitespace-only strings, are preserved. Loading defaults does not write settings or overwrite saved preferences.

The Options **Reset prompt** button replaces only the Prompt field with the current `DEFAULT_SETTINGS.optionalText` and focuses that field. It does not change placement, cleanup, automation, or saved settings. **Save** is required to persist the reset; closing or reloading without saving retains the previously saved prompt.

Automatic closing defaults to on only when `autoClose` is absent or undefined. Saved boolean values, including `false`, are preserved; other invalid values keep automatic closing disabled. Loading defaults does not persist settings. Disabling automatic submission leaves the saved automatic-close preference intact but makes it ineffective.

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

The memory sentence is a model instruction, not an enforced privacy boundary. It distinguishes using existing personal context for relevance from deriving new personal context from a shared article. Substantive follow-up must provide personal information; merely asking another question about the article is not evidence of a lasting interest or belief. The extension does not control ChatGPT Memory, reference-chat-history settings, or retention, and the link and summary remain part of the current conversation. See the [README privacy guidance](README.md#privacy-and-compatibility).

### Tracking-parameter cleanup

Cleanup applies only to valid HTTP and HTTPS URLs and removes every occurrence of these exact, case-sensitive parameter names:

- [Google Analytics][google-analytics]: `utm_id`, `utm_source`, `utm_medium`, `utm_campaign`, `utm_source_platform`, `utm_term`, `utm_content`, `utm_creative_format`, `utm_marketing_tactic`
- Google advertising ([click IDs][google-click-ids], [iOS IDs][google-ios-ids], [`gad_*`][google-gad], [Merchant Center][google-merchant]): `gclid`, `dclid`, `gbraid`, `wbraid`, `gad_source`, `gad_campaignid`, `srsltid`
- [Meta][meta-click-id], [Microsoft Advertising][microsoft-click-id], [TikTok][tiktok-click-id], and [LinkedIn][linkedin-click-id]: `fbclid`, `msclkid`, `ttclid`, `li_fat_id`
- [Mailchimp][mailchimp-tracking]: `mc_cid`, `mc_eid`, `mc_tc`

Cleanup scans the raw query once and parses the full URL only after finding a listed candidate, to validate its protocol. It reconstructs changed URLs from the original string, preserving the order and byte representation of retained parameters and the fragment. URLs without a listed parameter, invalid URLs, and non-HTTP(S) URLs are returned unchanged. Generic names such as `ref`, `source`, or `campaign` are not inferred to be tracking because they can control page functionality.

Firefox and Brave document the same general technique of removing known tracking parameters ([Firefox Query Parameter Stripping](https://firefox-source-docs.mozilla.org/toolkit/components/antitracking/anti-tracking/query-stripping/index.html), [Brave privacy features](https://brave.com/privacy-features/)). Removing any parameter can still invalidate a signature or one-time token covering the complete query; users can disable cleanup, and the extension does not guess which URLs are signed.

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
  prompt.ts           Settings normalization and prompt/deep-link construction
  selectors.ts        Isolated ChatGPT DOM selectors
  submission.ts       Pure submission-confirmation policy
  types.ts            Settings, dispatch, and message types
```

The extension uses no framework. esbuild bundles the three browser entry points into `dist/`.

The store artifact places `manifest.json` at the ZIP root alongside `options.html`, `options.css`, the three bundled JavaScript entry points, and the four manifest-referenced PNG icons. `scripts/package.mjs` uses an explicit runtime allowlist and replaces the versioned archive only after successful packaging; source maps, tests, development dependencies, and store materials are excluded. Packaging does not change runtime permissions or behavior. See [release preparation](AGENTS.md#chrome-web-store-release-preparation) for the contributor workflow.

## Permissions

```json
{
  "permissions": [
    "activeTab",
    "contextMenus",
    "scripting",
    "storage"
  ],
  "host_permissions": [
    "https://chatgpt.com/*"
  ]
}
```

The content script is statically limited to `https://chatgpt.com/*` and runs at `document_start` so it can capture the temporary dispatch marker before the client-rendered application changes history. The `scripting` permission is used only when the link-or-page command is invoked; `activeTab` grants temporary access to inspect the active page without persistent all-sites host access.

No all-sites permission, paid OpenAI API, ChatGPT `/backend-api/` access, or third-party telemetry is permitted. The manifest declares Chrome 120 as the minimum supported version, matching the production build target.

## Prompt and dispatch flow

1. The service worker reads the target URL and local settings, then applies enabled tracking-parameter cleanup before constructing the prompt.
2. It generates a random UUID and stores a `pending` dispatch in `chrome.storage.session` before navigation. The payload retains only the generated prompt, tab IDs, timestamps, transition status, and applicable automation flags; it does not duplicate the target URL or retain the source title.
3. It creates an inactive `about:blank` tab, persists the target tab binding and tab index, and only then navigates that tab to ChatGPT. This ordering prevents the content script from claiming a dispatch before its target binding is stored.
4. The ChatGPT deep link contains the existing `prompt` query and a temporary hash marker:

   ```text
   #share-to-chatgpt-dispatch=<UUID>
   ```

5. The content script does nothing in ChatGPT tabs without this marker.
6. For a marked tab, it removes the hash with `history.replaceState` and claims the matching session payload through extension messaging.
7. The service worker verifies the sender's bound tab ID and changes the dispatch state to `claimed`.
8. The content script verifies the expected prompt or injects it and verifies the resulting composer state.
9. If `autoSubmit` is disabled, the dispatch completes in the `claimed` state and the tab remains open.
10. If `autoSubmit` is enabled, the content script requests the `claimed → submitting` transition before invoking submission. When auto-close is enabled, the successful transition extends the dispatch expiry to approximately 120 seconds so conversation persistence or the response-completion fallback can be verified.
11. A successful or final failed dispatch removes its session payload and tab index. Closing the target tab also removes its state.

A dispatch can be claimed and armed only once. The state transition before submission favors a missed submission over a duplicated submission if execution is interrupted at the boundary.

The source tab's extension action shows a blue `…` while its latest dispatch is active. Completion changes this to a green `✓` for approximately two seconds, with an action title that distinguishes a submitted prompt from a prefilled prompt. These status updates contain no URL or prompt data. A delayed result from an older dispatch cannot overwrite the source status owned by a newer dispatch. Source status is also cleared when that tab navigates; timer-based clearing is best-effort because a Manifest V3 service worker may stop.

## Readiness and time bounds

Readiness uses `MutationObserver` on `main` (the document until `main` exists), rebinding if React replaces the root. It observes child/text changes and `disabled`, `aria-disabled`, `contenteditable`, `aria-label`, `type`, and `data-markdown-text-style`, including in-place Send-to-Stop changes. Bounded 250 ms polling covers URL-only changes and missed events; no fixed page-load sleep is used. Success, timeout, and reader failure all release observers and timers.

A pending or claimed dispatch expires approximately 15 seconds after creation. Arming an auto-close dispatch extends its expiry to approximately 120 seconds from that transition; other armed dispatches retain the original expiry. Expiration is checked on every dispatch message, at service-worker startup, and opportunistically before a new dispatch. Service-worker timers provide prompt cleanup while the worker remains active; correctness does not depend on exact timer delivery.

Current bounded phases are:

- Deep-link prefill grace: up to 4 seconds.
- Prompt injection verification: up to 3 seconds.
- Submission confirmation: up to 2 seconds.
- Conversation-persistence and assistant-response detection for auto-close: bounded by the extended dispatch lifetime of approximately 120 seconds from arming.

## Selector strategy

All ChatGPT selector logic is isolated in `src/selectors.ts`.

### Current-frontend compatibility policy

Target the currently observed frontend. Replace obsolete selectors, logic, tests, and documentation rather than retaining legacy branches or aliases. These selector listings describe today's integration, not a historical compatibility requirement. Keep fallbacks only for demonstrated current interactions or documented safety/recovery needs.

Preserve supported interactions, exact prompt verification, one-way dispatch, time bounds, privacy, and fail-closed behavior. Verify changes in a [live debug session](AGENTS.md#live-chatgpt-troubleshooting), including streaming and reopening early-closed conversations.

### Composer

Priority:

1. `main form[data-chatgpt-composer] [data-composer-markdown][contenteditable="true"][role="textbox"]`
2. `main form [contenteditable="true"][role="textbox"]`
3. `main form textarea[name="prompt"]`

All candidates stay inside a main-content form; no historical ID or page-wide form matching.

Read textarea values directly. The observed contenteditable editor represents input lines as direct `p` children, including empty paragraphs containing a terminal `br.ProseMirror-trailingBreak` placeholder. Read text nodes and hard `br` line breaks, ignore only that terminal placeholder, and join paragraphs with one LF. Flat text/`br` content from insertion uses the same reader. Do not use layout-dependent `innerText` for verification: it adds visual paragraph spacing that is not part of the prompt. Unrecognized elements or mixed paragraph structures are unverifiable and must not pass prompt checks.

### Send button

Use an enabled `button[type="submit"]` inside the composer's form, respecting `disabled` and `aria-disabled`. Do not depend on localized labels, historical test IDs, or page-wide “Send” text matching.

### Assistant response

Response markers:

```css
main [data-chatgpt-conversation-selection-target] [data-turn-key] [data-markdown-text-style="assistant-message"]
button[type="button"][aria-label="Stop"] /* restricted to the composer's form */
```

Count each turn with non-empty assistant markdown once. User text, toolbar labels, empty placeholders, and turn existence alone do not qualify. Do not require finalized message IDs: the observed UI adds them only after streaming ends.

Only UUID-shaped `/c/<UUID>` paths count as persistence evidence. Temporary paths such as the observed `/c/local-chatgpt%3A<UUID>` and unrelated paths do not. With the composer observable, close when either condition holds:

- **Canonical path:** an enabled scoped Stop exists, or the non-empty assistant-turn count increases. The Stop fast path skips text scans; the count path also works when Stop is unrecognized.
- **No canonical path:** an observed enabled Stop disappears and a new non-empty assistant turn exists. A disabled but present Stop is not disappearance.

Otherwise leave the tab open at timeout. Latch non-empty response detection per dispatch; never retain response text. These UI signals do not guarantee server persistence or continued generation. Live validation must reopen the exact early-closed conversation and verify a non-empty response.

## Prompt insertion

The deep link is given an opportunity to prefill the composer first.

If fallback insertion is required:

- A textarea uses the native `HTMLTextAreaElement.prototype.value` setter and an `input` event.
- A contenteditable composer uses selection plus `document.execCommand("insertText")`.
- If that does not produce the expected value, the composer receives a paragraph node populated through the native `innerText` setter (which represents line breaks as `br` nodes), followed by an `input` event. Prompt text is never interpreted as HTML.

The composer is read back after insertion. Submission is forbidden unless its normalized text exactly equals the expected prompt. Comparison normalizes non-breaking spaces, CRLF line endings, and surrounding whitespace only; internal line breaks and blank lines must match. Collapsed or missing paragraphs do not qualify.

## Submission and automatic closing

Immediately before submission, the content script rechecks that:

1. The composer exists.
2. The expected prompt is present.
3. The scoped Send button exists.
4. The Send button is enabled.
5. The dispatch was successfully armed by the service worker.

After the asynchronous arming reply, the script reacquires the composer and enabled Send control and verifies the exact prompt again. A change at that boundary fails closed without submitting, retrying, or arming a second time.

Submission uses:

```js
form.requestSubmit(button);
```

`button.click()` is used only when the form is unavailable or `requestSubmit` throws. No synthetic keyboard event is used.

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

Handled conditions include:

- A shortcut invoked on a page where Chrome forbids script injection.
- Logged-out sessions.
- Interstitials or challenges.
- Missing composer.
- Failed prompt injection.
- Missing or disabled Send button.
- Changed ChatGPT selectors.
- Closely timed multiple dispatches.

A missing response-start marker or unverified auto-close condition after a confirmed submission is nonfatal: the extension logs a console error, consumes the completed dispatch, and leaves the tab open. It does not show a failure badge for a message that was already submitted.

## Security and privacy

- Before navigation, prompts, settings, and dispatch state are held only in local extension storage and memory. Dispatch payloads do not separately retain source titles or duplicate target URLs.
- The temporary dispatch hash contains only a random UUID and is removed immediately.
- The prompt remains in the `?prompt=` query because that is the existing deep-link prefill mechanism.
- Runtime messages are accepted only from `https://chatgpt.com/` tabs and are bound to the expected target tab ID.
- The constructed prompt is sent only to `chatgpt.com` through normal page navigation. No browsing data, prompt, or ChatGPT content is sent to any other service.
- Assistant message content is checked only for non-emptiness and is never stored.

## Manual regression checklist

Run the cases relevant to a change and report which cases were verified in the current build. The checklist records required coverage, not historical test status.

- Log in to `https://chatgpt.com` normally.
- On a non-ChatGPT page, click the toolbar button once.
- Confirm the original tab remains selected throughout.
- Confirm one background ChatGPT tab opens with the page URL in the composer and submits one initial message.
- Confirm no Enter key or second click is needed and the ChatGPT tab remains open when auto-close is disabled.
- Right-click a link, choose **Send link to ChatGPT**, and confirm the linked URL—not the current page URL—is submitted.
- Hover over a link, press the configured shortcut, and confirm the linked URL—not the current page URL—is submitted.
- Press the shortcut without hovering a link and confirm the current page URL is submitted.
- Press the shortcut on a Chrome-restricted page and confirm no ChatGPT tab opens, a red `!` badge appears, and hovering the extension action reports that the shortcut is unavailable on that page.
- Change the shortcut through `chrome://extensions/shortcuts`, reload the extension, and confirm the new shortcut triggers the same link-or-page workflow.
- With link cleanup enabled, send a URL containing `utm_source`, `fbclid`, and an unrelated query parameter; verify the listed tracking parameters are absent while the unrelated parameter and fragment remain.
- Disable link cleanup, send the same URL, and verify it remains unchanged.
- Save prepend text in **Options**, send a page, and verify `text + space + cleaned URL`.
- Save append text, send a link, and verify `cleaned URL + two LF line breaks + text`.
- In Options with a saved custom prompt and non-default settings, click **Reset prompt** and verify the latest default Prompt appears while other settings remain unchanged. Repeat after editing or clearing the Prompt. Reload without saving and verify the saved custom prompt returns; reset and save, then reopen and verify the default persists.
- In a fresh extension profile, confirm Options displays the default Prompt. Clear it, save, reopen Options, and confirm it stays empty and sharing sends only the URL. Existing custom prompts must also remain unchanged after reload.
- Save Prompt text with multiple paragraphs, blank lines, and single line breaks; verify they survive both prepend and append, deep-link prefill, and fallback insertion. In the current contenteditable editor, verify direct paragraphs and empty-paragraph placeholders compare as logical lines, without accepting missing blank lines or collapsed text. Repeat with automatic submission disabled, then enabled, verifying one correctly formatted message and no collapsed paragraphs. If exact formatting cannot be verified, confirm the tab stays open without submission.
- Trigger two dispatches close together and verify each target tab submits its own prompt once.
- Log out of ChatGPT or block the composer, dispatch again, and confirm no prompt is submitted, the tab remains open, and a red `!` badge or error appears.
- Open an unrelated ChatGPT tab and confirm it does not auto-submit anything.
- Disable automatic submission and confirm the correct prompt is prefilled but not submitted.
- In a fresh profile, confirm automatic closing is checked. Save it off, reload Options, and confirm it remains off. Disable automatic submission and confirm the closing control is disabled without losing its saved preference. With automatic submission on and the default automatic closing on, confirm the background tab remains open on temporary paths such as `/c/local-chatgpt%3A<UUID>`, then closes after a canonical `/c/<UUID>` path appears while the enabled form-scoped Stop button is present, without waiting for assistant text or the full response. Reopen that exact conversation and verify it loads with a non-empty response.
- On the observed ChatGPT UI with a form-scoped contenteditable textbox and no composer ID, confirm one submission and automatic closing after a canonical `/c/<UUID>` path and new non-empty assistant markdown appear, even without a recognized Stop button or finalized message IDs.
- Repeat with no deep-link prefill and confirm fallback insertion is recognized by ChatGPT, submitted once, and followed by early closing and successful reopening.
- Confirm user text and empty assistant placeholders do not trigger closing; temporary conversation paths without a verified streaming-completion transition remain open.
- Reload the extension and confirm automation settings retain their saved values.

## Inherently fragile behavior

ChatGPT's composer markup, React/contenteditable behavior, deep-link prefill support, test IDs, submission controls, and assistant-message attributes are not public APIs. Account-specific experiments, localization, login challenges, or future DOM changes can break these integrations.

Selector failures must remain narrow and fail closed. When ChatGPT changes its DOM, update `src/selectors.ts` using observed markup rather than adding broad page-wide text matching.
