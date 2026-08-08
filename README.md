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
- Supports optional text before or after the URL.
- Can prefill without submitting.
- Can close the ChatGPT tab after ChatGPT assigns a canonical conversation URL and starts responding.
- Shows data-safe progress, success, and failure states on the extension action.
- Uses the existing signed-in `chatgpt.com` session—no OpenAI API key or paid API.

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

| Option | Default | Behavior |
| --- | --- | --- |
| Optional text | Empty | Added before or after the URL. Line breaks are normalized to spaces. |
| Remove common tracking parameters from shared URLs | On | Removes the known parameters listed below while preserving other query parameters and fragments. |
| Automatically submit the prompt | On | Turn off to prefill the composer without submitting. |
| Close the ChatGPT tab after ChatGPT assigns a conversation URL and starts responding | Off | Closes after a canonical `/c/<UUID>` URL appears together with either ChatGPT's form-scoped Stop button or a new non-empty assistant message. If the canonical URL is unavailable, response completion is the fallback. Waits up to approximately two minutes. Requires automatic submission. |

With link cleanup enabled, the extension removes these exact, case-sensitive parameter names from HTTP and HTTPS URLs:

- Google Analytics campaign tags: `utm_id`, `utm_source`, `utm_medium`, `utm_campaign`, `utm_source_platform`, `utm_term`, `utm_content`, `utm_creative_format`, and `utm_marketing_tactic`.
- Google advertising identifiers: `gclid`, `dclid`, `gbraid`, `wbraid`, `gad_source`, `gad_campaignid`, and Merchant Center `srsltid`.
- Other advertising click identifiers: Meta `fbclid`, Microsoft Advertising `msclkid`, TikTok `ttclid`, and LinkedIn `li_fat_id`.
- Mailchimp campaign, recipient, and product-recommendation identifiers: `mc_cid`, `mc_eid`, and `mc_tc`.

The conservative list, exact cleanup contract, and provider sources are documented in [spec.md](spec.md#tracking-parameter-cleanup). Signed or single-use links can cover the complete query string with an integrity check; turn cleanup off if removing a listed parameter makes a link unusable.

## Development

The complete behavior contract, architecture, failure handling, security constraints, selector strategy, and manual regression checklist are in [spec.md](spec.md).

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

Settings and dispatch state stay in local Chrome extension storage. The constructed prompt—including the page or link URL—is sent only to `chatgpt.com` through normal page navigation and is not sent to any other service. The shortcut inspects the active page only when pressed, using Chrome's temporary `activeTab` access; the extension has no persistent all-sites access.

ChatGPT's DOM and deep-link behavior are not public APIs. The shortcut supports hovered links in normal document content and open Shadow DOM, but intentionally cannot inspect closed Shadow DOM or child frames. The extension leaves the tab open and refuses to submit when it cannot verify the expected prompt or required controls. The source tab shows a blue `…` while a dispatch is active and a brief green `✓` after completion. A failed dispatch shows a red `!`; hover the extension action for a data-safe failure category, with technical details kept in the local extension console. Status belongs to the latest dispatch from a source tab and is reset on navigation.
