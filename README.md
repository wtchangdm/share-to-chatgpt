# Share to ChatGPT

A Chrome extension that sends page or link URLs to ChatGPT in a background tab, with a customizable prompt and optional automatic submission and closing. Uses your signed-in ChatGPT session; no API key required.

## Build and install

Requires Chrome 120+, Node.js LTS, and npm. A Chrome Web Store release is not yet available.

```sh
npm install
npm run build
```

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select this project directory (containing `manifest.json`).
3. Sign in to [ChatGPT](https://chatgpt.com) and pin the extension if desired.

Reload the extension after rebuilding.

## Usage

- **Toolbar button:** share the current page URL.
- **Link context menu → Send link to ChatGPT:** share that link.
- **Command+B** (macOS) / **Ctrl+B** (other platforms): share the hovered link, or the current page if none is hovered. Customize at `chrome://extensions/shortcuts`.

The source tab stays active. Its extension badge shows blue `…` while sharing, brief green `✓` on completion, or red `!` on failure. Hover the icon for a failure category; status resets on navigation.

### Options

Right-click the extension icon → **Options**.

| Setting | Default | Behavior |
| --- | --- | --- |
| Prompt | Summary and analysis | Customize it or leave empty for URL-only sharing. Surrounding whitespace is trimmed; internal line breaks and blank lines are preserved. |
| Placement | After URL | Separates the URL and Prompt with a blank line; before-URL placement uses one space. |
| Remove tracking parameters | On | Removes [known tracking parameters](spec.md#tracking-parameter-cleanup), preserving other query data and fragments. Disable if cleanup breaks a signed or single-use link. |
| Automatically submit | On | Turn off to prefill without submitting. |
| Close automatically | On | Requires automatic submission. Closes once ChatGPT assigns a conversation URL and starts responding; if no canonical URL appears, response completion is the fallback. Waits up to about two minutes, not necessarily for the full answer. |

Saved preferences, including empty prompts and disabled automatic closing, are preserved. **Reset to defaults** immediately saves all defaults, replacing saved preferences and unsaved edits without clearing active dispatches or unrelated local data. See the [settings contract and default prompt](spec.md#settings).

## Privacy and compatibility

- Sharing provides the URL and prompt to the ChatGPT page's composer **even with automatic submission off**. They are not included in the ChatGPT navigation URL, but ChatGPT may read or save drafts before Send. Do not share confidential links or sensitive text; tracking cleanup is not a sensitive-data scrubber.
- Settings and temporary dispatch state stay in local extension storage. The extension sends data only to ChatGPT, does not upload page content, and never stores assistant responses. The shortcut uses temporary `activeTab` access, not persistent all-sites access. See [PRIVACY.md](PRIVACY.md).
- The default prompt's memory guidance is not enforced isolation. This extension opens regular chats and does not change ChatGPT settings; the article remains in conversation context. For stronger control, use [Memory settings](https://help.openai.com/en/articles/8590148-memory-in-chatgpt) or manually start a [Temporary Chat](https://help.openai.com/en/articles/8914046-temporary-chat-in-chatgpt).
- Only the current ChatGPT frontend is supported; DOM changes can break integration. Unverified prompts or controls prevent submission; uncertain closing conditions leave the tab open. Early closing cannot guarantee continued generation—disable it if you need the tab to remain open.
- Hovered links work in normal content and open Shadow DOM, not closed Shadow DOM or child frames.

Independent of OpenAI; normal ChatGPT access and usage limits apply.

## Troubleshooting with a live debug session

Debugging a signed-in profile requires Chrome 144+ and a trusted debugger with access to the **whole profile**:

1. Enable **Allow remote debugging** at `chrome://inspect/#remote-debugging`.
2. Agree on the ChatGPT tabs and test conversations, then approve Chrome's connection prompt.
3. Disable remote debugging afterward.

If unavailable, check `chrome://version`. Do not use `--remote-debugging-port` on your everyday profile; Chrome 136+ restricts it for the default data directory. No profile copy or cookie export is needed. Report the actual extension error, not its `content.js` source listing.

See the [debugging workflow](AGENTS.md#live-chatgpt-troubleshooting) and [Chrome documentation](https://developer.chrome.com/docs/devtools/agents/use-cases/auto-connect).

## Development

Run `npm run check` for TypeScript, ESLint, unit tests, and a production build. Do not edit generated `dist/` files.

- [Behavior, architecture, and manual regressions](spec.md)
- [Contributor workflow, benchmarks, and release preparation](AGENTS.md)
- [Store listing and reviewer instructions](store/listing.md)
