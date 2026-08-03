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
- Supports optional text before or after the URL.
- Can prefill without submitting.
- Can close the ChatGPT tab after ChatGPT starts responding.
- Uses the existing signed-in `chatgpt.com` session—no OpenAI API key or paid API.

## Build and install

Requirements: a current Node.js LTS release and npm.

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
- Right-click the extension icon and select **Options** to configure prompt text and automation.

| Option | Default | Behavior |
| --- | --- | --- |
| Optional text | Empty | Added before or after the URL. Line breaks are normalized to spaces. |
| Automatically submit the prompt | On | Turn off to prefill the composer without submitting. |
| Close the ChatGPT tab after ChatGPT starts responding | Off | Closes only after the first non-empty assistant message appears. Requires automatic submission. |

## Development

The complete behavior contract, architecture, failure handling, security constraints, selector strategy, and manual regression checklist are in [spec.md](spec.md).

Run the full automated validation suite with:

```sh
npm run check
```

Generated scripts are written to `dist/`; do not edit them directly.

## Privacy and compatibility

Settings and dispatch state stay in local Chrome extension storage. Browsing data and prompts are not sent to third-party services; the only external action is normal navigation to `chatgpt.com`.

ChatGPT's DOM and deep-link behavior are not public APIs. The extension intentionally leaves the tab open and refuses to submit when it cannot verify the expected prompt or required controls.
