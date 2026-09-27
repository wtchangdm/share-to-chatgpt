# Chrome Web Store listing copy

Prepared for the initial unlisted release, version 0.1.0. This file is submission copy, not evidence of publication or approval. The publisher must review the declarations against the final build before certifying them.

## Store listing

**Name:** Share to ChatGPT

**Summary:** Send the current page or a link to ChatGPT in a background tab.

**Language:** English

**Suggested category:** Productivity (choose the closest available category in the dashboard).

### Detailed description

Send a page or link URL to ChatGPT without leaving the tab you are reading.

Share to ChatGPT opens ChatGPT in a background tab using your existing signed-in session. It sends the URL with a customizable prompt; it does not upload a copy of the source page. ChatGPT's ability to access or summarize the linked page depends on that page and your ChatGPT session.

Three ways to share:
- Click the extension toolbar button to share the current page.
- Right-click a link and choose “Send link to ChatGPT.”
- Use Command+B on macOS or Ctrl+B on other platforms to share a hovered link, or the current page when no link is hovered. Customize or disable the shortcut at chrome://extensions/shortcuts.

Make it your workflow:
- Use the included summary-and-analysis prompt, write your own, or leave it empty to share only the URL.
- Place the prompt before or after the URL, preserving line breaks.
- Remove common tracking parameters while keeping other URL data. Turn cleanup off for signed or single-use links if needed.
- Automatically submit the verified prompt, or turn submission off to leave it in the composer.
- Optionally close the ChatGPT tab after a conversation URL is assigned and a response starts. Automatic closing is off by default and does not wait for the full answer or guarantee continued generation.

Getting started:
1. Install and pin the extension.
2. Sign in to chatgpt.com normally.
3. Right-click the extension icon and open Options to choose your prompt and automation preferences.
4. Share a public page or link using any of the three entry points.

Privacy:
Sharing sends the chosen URL and your prompt to ChatGPT over HTTPS, including when automatic submission is off. Settings stay in local Chrome extension storage; delivery state is temporary. The extension has no developer-operated data server, telemetry, ads, or data sales, and never stores assistant response content. Avoid sharing confidential URLs or sensitive prompt text. Tracking cleanup is not a sensitive-data scrubber. Read the linked privacy policy for details.

Compatibility:
Requires Chrome 120 or later and a signed-in ChatGPT session. No OpenAI API key is required; normal ChatGPT access and usage limits apply. This independent extension is not affiliated with or endorsed by OpenAI. It relies on ChatGPT's current web interface, which can change. If the prompt or controls cannot be verified, it leaves the tab open rather than submitting uncertain content.

### Images

- Extension/store icon: `icons/icon128.png` (128×128 PNG, 96×96 artwork with transparent padding).
- Small promotional tile: `store/promo-440x280.png` (440×280 PNG; source: `store/promo.svg`).
- Screenshot: `store/screenshot-options.png` (1280×800 PNG). Caption: “Customize your prompt, link cleanup, and submission preferences.” Captured from the actual extension Options page with default settings in an isolated browser; no ChatGPT conversation or personal data is shown.

## Privacy practices

### Single purpose

Send a user-selected page or link URL with a customizable prompt to ChatGPT in a background tab, with optional verified submission and automatic closing.

### Permission justifications

| Permission | Text for the dashboard |
| --- | --- |
| `activeTab` | Temporarily access the active page when the user invokes sharing, to obtain its URL and, for the keyboard shortcut, inspect the currently hovered link. No persistent access to all websites is requested. |
| `contextMenus` | Add “Send link to ChatGPT” to the link context menu so the user can share the selected link URL. |
| `scripting` | Run the hovered-link lookup in the active page's main frame only when the user invokes the keyboard shortcut, using activeTab access. |
| `storage` | Store prompt and automation preferences locally, and keep temporary session-only dispatch and tab-status state to bind each request to its target tab, prevent duplicate submission, and clean up completion or failure. |
| `https://chatgpt.com/*` | Run the packaged content script on ChatGPT to handle extension-marked requests: verify or insert the exact prompt, optionally submit through the normal page controls, and optionally observe the conversation URL and response-start signals before closing the extension-created tab. Unmarked ChatGPT tabs are not automated. |

### Remote code

Select **No, I am not using remote code**. Executable extension code is bundled in the uploaded package. The extension interacts with ChatGPT's normal DOM; it does not download executable extension code, use eval, or call ChatGPT private APIs.

### Data disclosures

Do **not** select “I do not collect or use user data.” The extension handles and transmits URLs and user-written prompts even though the developer has no server.

Use these conservative declarations, checking the dashboard's current definitions before submission:

- **Web history:** the specific page/link URL the user asks to share, not a record of all browsing.
- **Website content:** the user-written prompt and composer contents; assistant content is inspected locally only for non-emptiness when automatic closing is enabled and is never stored.
- **Personal communications:** prompts sent to ChatGPT and the limited local response-presence check. There is no background collection of unrelated conversations.

The extension does not separately collect identity, payment, health, authentication, location, or interaction-tracking data. URLs and free-form prompts may contain sensitive information chosen by the user; the policy warns against sharing it. Do not claim that arbitrary user input has been sanitized.

Certify the following only after confirming that the final implementation and policy still match:
- Data is not sold or transferred to third parties outside the permitted use cases; transfer to ChatGPT provides the extension's single purpose.
- Data is not used or transferred for purposes unrelated to that single purpose.
- Data is not used or transferred to determine creditworthiness or for lending purposes.

### Privacy policy URL

Publish `PRIVACY.md` at a stable, publicly readable HTTPS URL and enter that URL in the dashboard. A public repository's rendered file URL is sufficient; a separate website is not required. Verify it while signed out. No store privacy-policy URL has been selected or verified by this preparation task.

## Reviewer test instructions

Requires Chrome 120+ and the reviewer's own signed-in ChatGPT account. No extension account, API key, or developer credentials are required. Do not supply a personal ChatGPT password or cookies.

1. Sign in to https://chatgpt.com/ normally. Open extension Options and set Prompt to `Reply with only OK.` to keep the test bounded. Leave automatic submission on and automatic closing off.
2. Open https://example.com/ and click the extension toolbar button once. The source tab should stay selected. One background ChatGPT tab should open and submit one prompt containing the instruction and URL. It should remain open.
3. Use the link context menu on a public link, then test the configured shortcut with and without hovering a link. Each invocation should share the intended URL once. Chrome may reserve shortcuts; assign an available shortcut at chrome://extensions/shortcuts if needed.
4. Turn automatic submission off and share again. The prompt should be prefilled, not submitted. Navigation still sends the prompt to ChatGPT.
5. Turn submission back on and enable automatic closing. Share again. The target should close only after the documented conversation/response signals; it should stay open on uncertainty or timeout. Reopen the resulting conversation from ChatGPT history and verify a response exists.
6. Confirm an unrelated ChatGPT tab is not auto-submitted. If logged out or the composer is unavailable, the extension must not submit uncertain content.
7. Restore the desired Options values after testing. Do not include conversation content in review logs.

The complete manual regression checklist is in `spec.md`; this short sequence is for store reviewers, not a replacement for release validation.

## Distribution fields

- **Visibility:** Unlisted. Anyone with the store link can install; it is not an allowlist.
- **Pricing:** Free extension. ChatGPT access is separate.
- **Regions:** Publisher choice; include the regions where intended recipients live.
- **Automatic publication after review:** Disable it for the first submission so the publisher can make the final publication decision separately.
- **Publisher name/contact email:** Publisher must supply and verify these in the developer account.
- **Homepage/support URL:** Optional. Use the repository/support page only after verifying public access and that support is enabled. Do not invent a store URL or item ID before creation.

Official references: [preparation](https://developer.chrome.com/docs/webstore/prepare), [images](https://developer.chrome.com/docs/webstore/images), [privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy), [user data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), [distribution](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution).
