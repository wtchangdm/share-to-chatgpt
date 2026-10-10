# Share to ChatGPT

A local Chrome Manifest V3 extension that sends the current page or a link to ChatGPT without interrupting the active tab.

It replaces this bookmarklet workflow:

```js
javascript:(()=>{window.open(`https://chatgpt.com/?prompt=${encodeURIComponent(location.href)}`,"_blank","noopener,noreferrer")})()
```

## Features

- Opens ChatGPT in a background tab.
- Sends the active page URL from the toolbar button.
- Adds **Send link to ChatGPT** to link context menus.
- Sends a hovered link—or the current page when no link is hovered—with `Command+B` on macOS or `Ctrl+B` on other platforms.
- Removes common campaign and click-tracking parameters while preserving other URL data.
- Includes a customizable summary-and-analysis prompt before or after the URL; leave it empty to send only the URL.
- Can prefill without submitting.
- Can close the ChatGPT tab after ChatGPT assigns a canonical conversation URL and starts responding.
- Shows data-safe progress, success, and failure states on the extension action.
- Uses the existing signed-in `chatgpt.com` session—no OpenAI API key or paid API.

## Chrome Web Store installation

The unlisted release is being prepared; no store installation link is available yet. Once published, open the store link shared by the publisher and choose **Add to Chrome**. Store installation does not require Node.js, a build, or Developer mode. Anyone who receives or is forwarded an unlisted link can install it; unlisted does not mean private access.

After installation, sign in to `https://chatgpt.com`, pin the extension, and review **Options** before sharing. This is an independent extension, not affiliated with or endorsed by OpenAI. Normal ChatGPT access and usage limits apply.

## Build and install

Requirements: Chrome 120 or newer, a current Node.js LTS release, and npm.

```sh
npm install
npm run build
```

Then:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this project directory (the directory containing `manifest.json`).
5. Sign in to `https://chatgpt.com` normally.
6. Pin **Share to ChatGPT** if desired.

Reload the extension from `chrome://extensions` after rebuilding it.

## Usage

- Click the toolbar button to send the active page URL.
- Right-click a link and select **Send link to ChatGPT** to send that link URL.
- Press `Command+B` on macOS or `Ctrl+B` on other platforms to send the hovered link URL, or the current page URL when no link is hovered.
- Customize or disable the shortcut at `chrome://extensions/shortcuts`.
- Right-click the extension icon and select **Options** to configure sharing and automation.
- In Options, **Reset prompt** restores the latest default Prompt without changing other settings. Click **Save** to keep it; closing without saving leaves the saved prompt unchanged.

| Option | Default | Behavior |
| --- | --- | --- |
| Prompt | Summary and analysis instructions | Added after the URL by default with two line breaks (one blank line), or before it with one space. Can be empty to send only the URL. Preserves line breaks and blank lines; trims surrounding whitespace. |
| Remove common tracking parameters from shared URLs | On | Removes the known parameters listed below while preserving other query parameters and fragments. |
| Automatically submit the prompt | On | Turn off to prefill the composer without submitting. |
| Close the ChatGPT tab after ChatGPT assigns a conversation URL and starts responding | On | Closes after a canonical `/c/<UUID>` URL appears together with either ChatGPT's enabled form-scoped Stop button or a new non-empty assistant response. Does not wait for the full answer. If the canonical URL is unavailable, response completion is the fallback. Waits up to approximately two minutes. Requires automatic submission. |

Automatic closing defaults to on when no value has been saved. Existing saved on/off choices are preserved. Turn it off in Options if you want the ChatGPT tab to stay open.

The default prompt asks for a brief summary, evidence-aware analysis, caveats, and personal relevance. It also asks ChatGPT not to derive memories or assumptions about you from the link or summary, reserving later updates for personal information you provide in substantive follow-up discussion. This is guidance, not enforced memory isolation; see [Privacy and compatibility](#privacy-and-compatibility). It applies when no prompt has been saved; existing saved prompts, including empty ones, remain unchanged. Placement defaults to after the URL; existing saved placement choices remain unchanged. The exact default is documented in [spec.md](spec.md#default-prompt).

With link cleanup enabled, the extension removes these exact, case-sensitive parameter names from HTTP and HTTPS URLs:

- Google Analytics campaign tags: `utm_id`, `utm_source`, `utm_medium`, `utm_campaign`, `utm_source_platform`, `utm_term`, `utm_content`, `utm_creative_format`, and `utm_marketing_tactic`.
- Google advertising identifiers: `gclid`, `dclid`, `gbraid`, `wbraid`, `gad_source`, `gad_campaignid`, and Merchant Center `srsltid`.
- Other advertising click identifiers: Meta `fbclid`, Microsoft Advertising `msclkid`, TikTok `ttclid`, and LinkedIn `li_fat_id`.
- Mailchimp campaign, recipient, and product-recommendation identifiers: `mc_cid`, `mc_eid`, and `mc_tc`.

The conservative list, exact cleanup contract, and provider sources are documented in [spec.md](spec.md#tracking-parameter-cleanup). Signed or single-use links can cover the complete query string with an integrity check; turn cleanup off if removing a listed parameter makes a link unusable.

## Troubleshooting with a live debug session

Debugging your existing signed-in profile requires **Chrome 144+**; the extension itself requires Chrome 120+.

1. In the affected profile, open `chrome://inspect/#remote-debugging` and enable **Allow remote debugging**.
2. Identify the ChatGPT tab and authorize any new test conversations.
3. Approve Chrome's **Allow** prompt when the debugger connects. Login state and extensions are reused; no cookie export or profile copy is needed.
4. Disable remote debugging afterward.

Access covers the whole profile: use only a trusted debugger and agreed tabs/tests. If the option is missing, check `chrome://version`. Do not substitute `--remote-debugging-port` on your everyday profile; Chrome 136+ restricts it for the default data directory.

See [Chrome's documentation](https://developer.chrome.com/docs/devtools/agents/use-cases/auto-connect) and the [debugging workflow](AGENTS.md#live-chatgpt-troubleshooting). Report the actual extension error message, not just its `content.js` source listing.

## Development

The complete behavior contract, architecture, failure handling, security constraints, selector strategy, and manual regression checklist are in [spec.md](spec.md).

Release packaging and submission preparation are documented in [AGENTS.md](AGENTS.md#chrome-web-store-release-preparation). Prepared store copy and asset paths are in [store/listing.md](store/listing.md).

Run the full automated validation suite with:

```sh
npm run check
```

Query-cleanup performance changes also require repeatable before/after measurement:

```sh
npm run benchmark:query-stripping
```

Generated scripts are written to `dist/`; do not edit them directly.

## Privacy and compatibility

Read the [privacy policy](PRIVACY.md) for data use, retention, and your choices. Sharing sends the URL and prompt to ChatGPT even when automatic submission is disabled, because they are included in the navigation URL. Browser history and ChatGPT may retain that information. Do not share confidential links or sensitive prompt text; tracking cleanup is not a sensitive-data scrubber.

Prompt instructions cannot guarantee exclusion from ChatGPT [Memory or reference chat history](https://help.openai.com/en/articles/8590148-memory-in-chatgpt), and the article remains in the current conversation's context. For stronger control, use ChatGPT's Memory settings or manually start a [Temporary Chat](https://help.openai.com/en/articles/8914046-temporary-chat-in-chatgpt), which does not create or update memories while temporary. This extension opens regular chats; it does not enable Temporary Chat or change your ChatGPT settings.

Settings and dispatch state stay in local Chrome extension storage. The constructed prompt—including the page or link URL—is sent only to `chatgpt.com` through normal page navigation and is not sent to any other service. The shortcut inspects the active page only when pressed, using Chrome's temporary `activeTab` access; the extension has no persistent all-sites access.

Only the currently observed ChatGPT frontend is supported; its DOM and deep links are not public APIs. Hovered links work in normal content and open Shadow DOM, not closed Shadow DOM or child frames.

Unverified prompts or controls prevent submission; unverified closing conditions leave the tab open. Early closing uses ChatGPT's visible URL and response controls but cannot guarantee continued generation. Disable it if the tab must stay open until the full answer finishes.

The source tab shows blue `…` during dispatch, brief green `✓` on completion, or red `!` on failure. Hover the action for a data-safe failure category; technical details stay in the local extension console. Status belongs to the latest dispatch and resets on navigation.
