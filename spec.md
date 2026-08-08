# Share to ChatGPT specification

## Purpose

Replace the foreground-interrupting bookmarklet workflow with a local Chrome extension that opens ChatGPT in a background tab, safely prefills the expected prompt, and optionally submits and closes the tab after ChatGPT assigns a canonical conversation URL and starts responding.

The original bookmarklet workflow is:

```js
javascript:(()=>{window.open(`https://chatgpt.com/?prompt=${encodeURIComponent(location.href)}`,"_blank","noopener,noreferrer")})()
```

With default settings, the prompt is the target URL after the conservative tracking-parameter cleanup defined below. A URL without a listed tracking parameter remains byte-for-byte unchanged, and the ChatGPT deep link remains:

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
7. Optionally close the ChatGPT tab after the temporary `/c/WEB:<UUID>` path changes to a canonical `/c/<UUID>` conversation path and either the form-scoped Stop button or a new non-empty assistant message indicates that a response started. If no canonical path is observed, completed streaming is the fail-safe fallback.

### Link context menu

The **Send link to ChatGPT** menu item appears for links and follows the same workflow using `info.linkUrl` instead of the active page URL.

### Link-or-page shortcut

When invoked with `Command+B` on macOS or `Ctrl+B` on other platforms, the shortcut uses the resolved URL of a link hovered in the active page. If no link is hovered, it uses the current page URL instead. The command queries only `a[href]:hover` in the main frame at invocation time, recursively follows open shadow roots on the hovered element path, and chooses the deepest matching anchor before falling back to `document.location.href`. It does not inspect closed shadow roots or child frames. Injection failures produce a local console error and a red `!` badge on the active tab.

The shortcut is a suggested default, not a setting stored by the extension. Users can customize or disable it through `chrome://extensions/shortcuts`.

## Settings

Settings are stored under `settings` in `chrome.storage.local`.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `optionalText` | `string` | `""` | Text added to the target URL. |
| `placement` | `"prepend" \| "append"` | `"prepend"` | Whether optional text appears before or after the URL. |
| `stripTrackingParameters` | `boolean` | `true` | Whether known tracking parameters are removed before prompt construction. |
| `autoSubmit` | `boolean` | `true` | Whether the verified prompt is submitted automatically. |
| `autoClose` | `boolean` | `false` | Whether the target tab closes after ChatGPT assigns a canonical conversation URL and starts responding. Effective only when `autoSubmit` is enabled. |

A blank optional-text value produces only the cleaned or original target URL. Non-empty optional text and the URL are separated by one space. Line breaks in optional text are normalized to spaces to avoid contenteditable paragraph mismatches.

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

ChatGPT is treated as a client-rendered application. Readiness uses `MutationObserver` plus bounded 250 ms fallback polling; it does not rely on a fixed page-load sleep.

A pending or claimed dispatch expires approximately 15 seconds after creation. Arming an auto-close dispatch extends its expiry to approximately 120 seconds from that transition; other armed dispatches retain the original expiry. Expiration is checked on every dispatch message, at service-worker startup, and opportunistically before a new dispatch. Service-worker timers provide prompt cleanup while the worker remains active; correctness does not depend on exact timer delivery.

Current bounded phases are:

- Deep-link prefill grace: up to 4 seconds.
- Prompt injection verification: up to 3 seconds.
- Submission confirmation: up to 2 seconds.
- Conversation-persistence and assistant-response detection for auto-close: bounded by the extended dispatch lifetime of approximately 120 seconds from arming.

## Selector strategy

All ChatGPT selector logic is isolated in `src/selectors.ts`.

### Composer

Priority:

1. `#prompt-textarea`
2. Form-scoped `contenteditable="true"` with `role="textbox"`
3. Form-scoped prompt textarea
4. Narrow form-scoped textarea fallbacks

### Send button

Selection is restricted to the composer's form. Priority:

1. `button[data-testid="send-button"]`
2. Exact `aria-label="Send prompt"`
3. Exact `aria-label="Send message"`
4. `button[type="submit"]`

The extension never searches the entire page for a button whose visible text merely contains “Send”.

### Assistant response

Auto-close uses two narrow DOM markers and one narrow path pattern:

```css
[data-message-author-role="assistant"]
button[data-testid="stop-button"] /* restricted to the composer's form */
```

```text
/c/<UUID>
```

Either a form-scoped Stop button or a higher count of non-empty assistant-message markers establishes that a new response started. The observed ChatGPT flow first uses `/c/WEB:<UUID>` and then replaces it with canonical `/c/<UUID>` after assigning the conversation. Auto-close accepts only a UUID-shaped canonical path; unrelated and temporary paths fail closed. Once both the canonical path and either response-start marker exist, the tab may close immediately while the Stop button is still present and before assistant text appears. If the canonical path is not observed, an observed Stop-button present-to-absent transition plus a new assistant message provides the slower response-completion fallback. The extension does not inspect or store the assistant response text.

## Prompt insertion

The deep link is given an opportunity to prefill the composer first.

If fallback insertion is required:

- A textarea uses the native `HTMLTextAreaElement.prototype.value` setter and an `input` event.
- A contenteditable composer uses selection plus `document.execCommand("insertText")`.
- If that does not produce the expected value, the composer receives a paragraph node and an `input` event.

The composer is read back after insertion. Submission is forbidden unless its normalized text exactly equals the expected prompt.

## Submission and automatic closing

Immediately before submission, the content script rechecks that:

1. The composer exists.
2. The expected prompt is present.
3. The scoped Send button exists.
4. The Send button is enabled.
5. The dispatch was successfully armed by the service worker.

Submission uses:

```js
form.requestSubmit(button);
```

`button.click()` is used only when the form is unavailable or `requestSubmit` throws. No synthetic keyboard event is used.

Submission is confirmed when the composer remains observable and either no longer contains the expected prompt or its Send button becomes disabled. A temporarily missing composer is treated as uncertainty and does not confirm submission.

When `autoClose` is enabled, the content script records the number of non-empty assistant messages before submitting, checks for a canonical UUID conversation path, and observes the composer's form for the exact `button[data-testid="stop-button"]` streaming control. It asks the service worker to close the target tab with `chrome.tabs.remove` as soon as a canonical path exists together with either the Stop button or an increased assistant-message count; it does not wait for assistant text or the full response when the Stop button is available. If no canonical path is observed, it closes only after the Stop button has been observed and then disappears and the assistant-message count increases. If neither condition can be verified before the bounded timeout, the submitted tab remains open.

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
- Save append text, send a link, and verify `cleaned URL + space + text`.
- Trigger two dispatches close together and verify each target tab submits its own prompt once.
- Log out of ChatGPT or block the composer, dispatch again, and confirm no prompt is submitted, the tab remains open, and a red `!` badge or error appears.
- Open an unrelated ChatGPT tab and confirm it does not auto-submit anything.
- Disable automatic submission and confirm the correct prompt is prefilled but not submitted.
- Enable automatic closing and confirm the background tab remains open on `/c/WEB:<UUID>`, then closes after a canonical `/c/<UUID>` path appears while the form-scoped Stop button is present, without waiting for assistant text or the full response.
- Reload the extension and confirm automation settings retain their saved values.

## Inherently fragile behavior

ChatGPT's composer markup, React/contenteditable behavior, deep-link prefill support, test IDs, submission controls, and assistant-message attributes are not public APIs. Account-specific experiments, localization, login challenges, or future DOM changes can break these integrations.

Selector failures must remain narrow and fail closed. When ChatGPT changes its DOM, update `src/selectors.ts` using observed markup rather than adding broad page-wide text matching.
