# Share to ChatGPT

A small local Chrome Manifest V3 extension that replaces this bookmarklet:

```js
javascript:(()=>{window.open(`https://chatgpt.com/?prompt=${encodeURIComponent(location.href)}`,"_blank","noopener,noreferrer")})()
```

With the default settings, the prompt is exactly the selected page or link URL and the deep link remains `https://chatgpt.com/?prompt=...`. The extension opens that URL with `active: false`, waits for ChatGPT's composer, verifies the prompt, and submits it without using an API or changing the active tab.

## Build

Requirements: a current Node.js LTS release and npm.

```sh
npm install
npm run check
```

`npm run check` runs TypeScript checking, ESLint, unit tests, and the esbuild production build. Generated scripts are written to `dist/`.

## Install unpacked

1. Run `npm install` and `npm run build`.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select this project directory (the directory containing `manifest.json`).
5. Pin **Share to ChatGPT** if desired.
6. Ensure the normal `chatgpt.com` site is already logged in.

Clicking the toolbar button immediately sends the active page URL. Right-click a link and choose **Send link to ChatGPT** to send that link URL.

Right-click the extension's toolbar icon and choose **Options** to configure optional text and automation. **Automatically submit the prompt** defaults to enabled. **Close the ChatGPT tab after the conversation URL appears** defaults to disabled and is available only when automatic submission is enabled. All settings are kept only in `chrome.storage.local`.

A blank optional-text value preserves the bookmarklet's URL-only prompt exactly. Optional text and the URL are separated by one space; line breaks in optional text are normalized to spaces for reliable composer verification.

## Dispatch state flow

1. The service worker reads the page URL/title or context-menu link URL and the local optional-text setting.
2. It generates a random dispatch ID and writes a `pending` payload to `chrome.storage.session` before navigation. The payload includes the exact expected prompt, source metadata, a 15-second expiry, and eventually the new tab ID.
3. It calls `chrome.tabs.create({ url, active: false })`. The ChatGPT deep link includes the existing `prompt` query plus a short dispatch ID in the hash.
4. The content script runs only on `https://chatgpt.com/*`. It does nothing unless that hash marker exists, removes the marker immediately with `history.replaceState`, and claims the matching session payload through extension messaging.
5. If automatic submission is disabled, the content script stops after verifying the prefilled prompt and consumes the dispatch without clicking Send.
6. If automatic submission is enabled, the content script verifies the button and asks the service worker to change the state from `claimed` to `submitting` before invoking submission. A dispatch can be claimed and armed only once, preventing reloads or duplicate content-script execution from submitting it again.
7. When automatic closing is enabled, the content script waits until the URL matches `https://chatgpt.com/c/...`; only then does the service worker close the target tab with `chrome.tabs.remove`.
8. Success or final failure removes both the dispatch and tab-index state. Closing the target tab also cleans it up. Expired records are cleaned by the timeout and again whenever the service worker starts.

The prompt remains in the `?prompt=` query because that is the bookmarklet's source-of-truth prefill mechanism. The dispatch payload itself is transferred and validated through local extension storage and messaging; only the temporary random marker is added to the hash, and that marker is removed on startup.

## Composer and submission fallbacks

Selector logic is isolated in `src/selectors.ts`:

- Composer: `#prompt-textarea` first, then form-scoped `contenteditable`/`textarea` fallbacks.
- Send control: `button[data-testid="send-button"]` first, then only submit buttons or exact accessible labels inside the composer's own form.
- No page-wide button text search is used.

The script uses `MutationObserver` plus bounded 250 ms fallback polling rather than a fixed sleep. It first allows the deep link to prefill the composer. If that does not happen, it uses the native textarea value setter or contenteditable insertion plus an `input` event, then reads the composer back and requires an exact normalized match.

When automatic submission is enabled, submission is attempted with `form.requestSubmit(button)`. `button.click()` is used only if the form is missing or `requestSubmit` throws. The prompt is reverified and the button must be enabled immediately before the dispatch is armed. The script then requires evidence that the composer changed or the Send button became disabled.

Failures leave the ChatGPT tab open, log a clear console error, and place a red `!` badge on the source and target tabs when those tabs still exist. They never trigger a second submission attempt. If submission succeeds but a `/c/...` conversation URL does not appear within the bounded wait, automatic closing fails safely: the tab remains open and a console error explains why.

## Manual test checklist

- [x] Log in to `https://chatgpt.com` normally.
- [x] On a non-ChatGPT page, click the toolbar button once.
- [x] Confirm the original tab remains selected throughout.
- [x] Confirm one background ChatGPT tab opens with the page URL in the composer and submits one initial message.
- [x] Confirm no Enter key or second click is needed and the ChatGPT tab remains open.
- [x] Right-click a link, choose **Send link to ChatGPT**, and confirm the linked URL—not the current page URL—is submitted.
- [x] Save prepend text in **Options**, send a page, and verify `text + space + URL`.
- [x] Save append text, send a link, and verify `URL + space + text`.
- [x] Trigger two dispatches close together and verify each target tab submits its own prompt once.
- [x] Log out of ChatGPT (or block the composer), dispatch again, wait about 15 seconds, and confirm no prompt is submitted, the tab stays open, and a red `!` badge/error appears.
- [x] Open an unrelated ChatGPT tab and confirm it does not auto-submit anything.
- [ ] Disable **Automatically submit the prompt**, dispatch a page, and confirm the correct prompt is prefilled but not submitted and the tab remains open.
- [ ] Re-enable automatic submission, enable **Close the ChatGPT tab after the conversation URL appears**, dispatch a page, and confirm the URL changes to `/c/...` before the background tab closes.
- [ ] Reload the extension and confirm both automation settings retain their saved values.

## Inherently fragile behavior

ChatGPT's composer markup, React/contenteditable behavior, deep-link prefill support, test IDs, submission UI, and `/c/...` conversation URL shape are not public APIs. The isolated selector fallbacks reduce the impact of routine DOM changes but cannot guarantee compatibility with future ChatGPT releases, account-specific experiments, localization changes, login challenges, or interstitials. If a selector or controlled-input behavior changes, this extension intentionally fails closed rather than submitting empty, stale, or incorrect text.

All data stays local except for normal navigation to `chatgpt.com`. The extension does not call OpenAI APIs, inspect `/backend-api/` endpoints, or send browsing data to third parties.
