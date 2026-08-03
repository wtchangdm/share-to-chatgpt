# Share to ChatGPT specification

## Purpose

Replace the foreground-interrupting bookmarklet workflow with a local Chrome extension that opens ChatGPT in a background tab, safely prefills the expected prompt, and optionally submits and closes the tab.

The source-of-truth bookmarklet is:

```js
javascript:(()=>{window.open(`https://chatgpt.com/?prompt=${encodeURIComponent(location.href)}`,"_blank","noopener,noreferrer")})()
```

With default settings, the prompt is exactly the target URL and the ChatGPT deep link remains:

```text
https://chatgpt.com/?prompt=<encoded target URL>
```

## Supported interactions

### Toolbar button

1. Read the active tab URL and title.
2. Construct the prompt from the URL and saved settings.
3. Open ChatGPT with `chrome.tabs.create({ url, active: false })`.
4. Keep the original tab active.
5. Verify or inject the prompt in the ChatGPT composer.
6. Submit when automatic submission is enabled.
7. Optionally close the ChatGPT tab after the first non-empty assistant message appears.

### Link context menu

The **Send link to ChatGPT** menu item appears for links and follows the same workflow using `info.linkUrl` instead of the active page URL.

### Hovered-link shortcut

While a link is hovered in the active page, `Command+B` on macOS or `Ctrl+B` on other platforms follows the link context-menu workflow using that link's resolved URL. The command queries only `a[href]:hover` in the main frame at invocation time, chooses the deepest matching anchor, and otherwise fails closed without opening ChatGPT. Injection failures and the absence of a hovered link produce a local console error and a red `!` badge on the active tab.

The shortcut is a suggested default, not a setting stored by the extension. Users can customize or disable it through `chrome://extensions/shortcuts`.

## Settings

Settings are stored under `settings` in `chrome.storage.local`.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `optionalText` | `string` | `""` | Text added to the target URL. |
| `placement` | `"prepend" \| "append"` | `"prepend"` | Whether optional text appears before or after the URL. |
| `autoSubmit` | `boolean` | `true` | Whether the verified prompt is submitted automatically. |
| `autoClose` | `boolean` | `false` | Whether the target tab closes after ChatGPT starts responding. Effective only when `autoSubmit` is enabled. |

A blank optional-text value produces the exact bookmarklet prompt. Non-empty optional text and the URL are separated by one space. Line breaks in optional text are normalized to spaces to avoid contenteditable paragraph mismatches.

## Architecture

```text
src/
  background.ts    Service worker, commands, context menu, dispatch state, badges, tab lifecycle
  content.ts       ChatGPT readiness, prompt verification/injection, submission
  hovered-link.ts  Invocation-time hovered-link lookup for the active page
  options.ts       Local settings UI
  prompt.ts        Settings normalization and prompt/deep-link construction
  selectors.ts     Isolated ChatGPT DOM selectors
  types.ts         Settings, dispatch, and message types
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

The content script is statically limited to `https://chatgpt.com/*` and runs at `document_start` so it can capture the temporary dispatch marker before the client-rendered application changes history. The `scripting` permission is used only when the hovered-link command is invoked; `activeTab` grants temporary access to inspect the active page without persistent all-sites host access.

No all-sites permission, paid OpenAI API, ChatGPT `/backend-api/` access, or third-party telemetry is permitted.

## Prompt and dispatch flow

1. The service worker reads the target URL, source title, and local settings.
2. It generates a random UUID and stores a `pending` dispatch in `chrome.storage.session` before navigation.
3. The ChatGPT deep link contains the existing `prompt` query and a temporary hash marker:

   ```text
   #share-to-chatgpt-dispatch=<UUID>
   ```

4. The content script does nothing in ChatGPT tabs without this marker.
5. For a marked tab, it removes the hash with `history.replaceState` and claims the matching session payload through extension messaging.
6. The service worker binds the dispatch to the sender's tab ID and changes its state to `claimed`.
7. The content script verifies the expected prompt or injects it and verifies the resulting composer state.
8. If `autoSubmit` is disabled, the dispatch completes in the `claimed` state and the tab remains open.
9. If `autoSubmit` is enabled, the content script requests the `claimed → submitting` transition before invoking submission.
10. A successful or final failed dispatch removes its session payload and tab index. Closing the target tab also removes its state.

A dispatch can be claimed and armed only once. The state transition before submission favors a missed submission over a duplicated submission if execution is interrupted at the boundary.

## Readiness and time bounds

ChatGPT is treated as a client-rendered application. Readiness uses `MutationObserver` plus bounded 250 ms fallback polling; it does not rely on a fixed page-load sleep.

The dispatch expires approximately 15 seconds after creation. Current bounded phases are:

- Deep-link prefill grace: up to 4 seconds.
- Prompt injection verification: up to 3 seconds.
- Submission confirmation: up to 2 seconds.
- Assistant-message detection for auto-close: up to 10 seconds, bounded by the remaining dispatch lifetime.

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

Auto-close uses one narrow marker:

```css
[data-message-author-role="assistant"]
```

The target tab closes after the count of non-empty matching messages increases. It does not inspect or store the assistant response text.

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

Submission is confirmed when the composer no longer contains the expected prompt or its Send button becomes disabled.

When `autoClose` is enabled, the content script records the number of non-empty assistant messages before submitting and waits for that count to increase. It then asks the service worker to close the target tab with `chrome.tabs.remove`. If no assistant message starts before the bounded timeout, the submitted tab remains open.

## Failure behavior

The extension fails closed. It never intentionally submits an empty, stale, unverifiable, or duplicate prompt.

On final failure:

- Keep the ChatGPT tab open.
- Log a clear local console error.
- Show a red `!` badge on the source and target tabs when they still exist.
- Remove consumed dispatch state.
- Do not retry submission.

Handled conditions include:

- A hovered-link shortcut invoked without a hovered link or on a page where Chrome forbids script injection.
- Logged-out sessions.
- Interstitials or challenges.
- Missing composer.
- Failed prompt injection.
- Missing or disabled Send button.
- Changed ChatGPT selectors.
- Closely timed multiple dispatches.

A missing assistant-message marker after a confirmed submission is nonfatal: the extension logs a console error, consumes the completed dispatch, and leaves the tab open. It does not show a failure badge for a message that was already submitted.

## Security and privacy

- Prompts, URLs, settings, and dispatch state remain in local extension storage and memory.
- The temporary dispatch hash contains only a random UUID and is removed immediately.
- The prompt remains in the `?prompt=` query because that is the bookmarklet's source-of-truth prefill mechanism.
- Runtime messages are accepted only from `https://chatgpt.com/` tabs and are bound to the expected target tab ID.
- No browsing data or ChatGPT content is sent to third-party servers.
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
- Press the shortcut without hovering a link and on a Chrome-restricted page; confirm no ChatGPT tab opens and a red `!` badge or error appears.
- Change the shortcut through `chrome://extensions/shortcuts`, reload the extension, and confirm the new shortcut triggers the same hovered-link workflow.
- Save prepend text in **Options**, send a page, and verify `text + space + URL`.
- Save append text, send a link, and verify `URL + space + text`.
- Trigger two dispatches close together and verify each target tab submits its own prompt once.
- Log out of ChatGPT or block the composer, dispatch again, and confirm no prompt is submitted, the tab remains open, and a red `!` badge or error appears.
- Open an unrelated ChatGPT tab and confirm it does not auto-submit anything.
- Disable automatic submission and confirm the correct prompt is prefilled but not submitted.
- Enable automatic closing and confirm the background tab closes only after the first assistant text appears.
- Reload the extension and confirm automation settings retain their saved values.

## Inherently fragile behavior

ChatGPT's composer markup, React/contenteditable behavior, deep-link prefill support, test IDs, submission controls, and assistant-message attributes are not public APIs. Account-specific experiments, localization, login challenges, or future DOM changes can break these integrations.

Selector failures must remain narrow and fail closed. When ChatGPT changes its DOM, update `src/selectors.ts` using observed markup rather than adding broad page-wide text matching.
