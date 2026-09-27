# Share to ChatGPT privacy policy

Last updated: September 27, 2026

Share to ChatGPT is an independent Chrome extension, not an OpenAI product. Its single purpose is to send a page or link URL, together with your chosen prompt, to ChatGPT when you invoke the extension.

## Information the extension handles

- **URLs you choose to share.** Clicking the toolbar button uses the active page URL. The link context menu uses the selected link URL. The keyboard shortcut inspects the currently hovered link in the active page at invocation time, falling back to the page URL. The extension does not collect a history of the pages you visit or upload the source page's body content.
- **Prompt and preferences.** Your prompt text and automation preferences are stored in `chrome.storage.local` in your Chrome profile. They are not synced by the extension.
- **Temporary dispatch state.** The constructed prompt, tab identifiers, timestamps, a random dispatch identifier, status, and automation flags are held in extension memory and `chrome.storage.session` to deliver each request safely and avoid duplicate submission.
- **ChatGPT page state.** For extension-created requests, the extension reads the composer to verify the prompt and observes submission controls. When automatic closing is enabled, it also checks the conversation URL and whether a new assistant response is non-empty. It does not store assistant response content.
- **Local diagnostics.** Progress and failure indicators and technical console diagnostics remain in your browser. They are not uploaded to the developer.

The extension does not read your authentication cookies or passwords. It uses your existing signed-in ChatGPT browser session without exporting it.

## Where information is sent

When you invoke sharing, the extension navigates a background tab to `https://chatgpt.com/` over HTTPS. The constructed prompt, including the shared URL, is sent in the navigation's `prompt` query parameter. This happens even if automatic submission is disabled; disabling submission is not a way to keep the prompt off ChatGPT's servers.

If automatic submission is enabled, the extension submits the verified prompt through ChatGPT's normal web interface. OpenAI processes information sent to ChatGPT under its [privacy policy](https://openai.com/policies/privacy-policy/) and your ChatGPT account settings. ChatGPT may access the shared page as part of responding; the extension itself sends the URL, not a copy of the source page.

The extension has no developer-operated data server, analytics, advertising, or telemetry. It does not send URLs, prompts, preferences, dispatch state, or assistant responses to the developer or to any service other than ChatGPT. Chrome and ChatGPT may independently process browser activity under their own settings and policies; this policy covers the extension's behavior.

## Retention and your choices

Saved preferences remain until you change them, clear the extension's local data, or uninstall the extension. You can edit or clear your saved prompt in Options.

Temporary dispatch payloads are removed after completion, final failure, or closure of the target tab. They expire after approximately 15 seconds, or approximately 120 seconds from arming an automatic-close request. Cleanup is checked during dispatch handling and service-worker startup; a suspended worker can delay physical removal. Session storage is also cleared by Chrome when the browser session ends or the extension is disabled, reloaded, or updated.

The prompt-bearing navigation URL may be retained in browser history or by ChatGPT. Removing local extension data, uninstalling the extension, or closing a ChatGPT tab does not delete browser history or ChatGPT conversations. Manage those separately through Chrome and ChatGPT.

You can disable automatic submission, automatic closing, or tracking-parameter cleanup in Options. Automatic submission and automatic closing are on by default when no preferences have been saved. Existing saved on/off choices are preserved. Automatic closing requires automatic submission and does not wait for the full answer or guarantee continued generation. Do not share confidential URLs, private document links, passwords, access tokens, or sensitive prompt text. Tracking-parameter cleanup removes only a fixed list of tracking parameters; it is not a sensitive-data scrubber. Local extension storage is not a password vault and the extension does not add its own encryption to that storage.

## Limited Use

Share to ChatGPT's use and transfer of information received from Chrome APIs adheres to the Chrome Web Store User Data Policy, including its Limited Use requirements. Information is used only to provide the user-facing URL-sharing and associated prompt, submission, and closing features. Transfer to ChatGPT is necessary to provide that purpose. The developer does not sell this information, use it for advertising or creditworthiness decisions, or permit human access to it through a developer-operated service.

## Contact and changes

For privacy questions, use the developer contact email shown on the Chrome Web Store listing. Do not include private URLs, prompts, authentication data, or conversation content unless specifically needed and you choose to share them for support.

Changes to this policy will be published here with an updated revision date.
