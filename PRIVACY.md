# Share to ChatGPT privacy policy

Last updated: September 27, 2026

Share to ChatGPT is an independent Chrome extension, not an OpenAI product. It sends a page or link URL with your chosen prompt to ChatGPT only when invoked.

## Information handled

- **Shared URLs:** the toolbar uses the active page URL; the context menu uses the selected link; the shortcut checks the hovered link at invocation, falling back to the page URL. The extension neither collects browsing history nor uploads source-page content.
- **Preferences:** prompt text and automation settings stay in `chrome.storage.local` in your Chrome profile, without extension-provided sync.
- **Temporary delivery state:** extension memory and `chrome.storage.session` hold the constructed prompt, tab IDs, timestamps, random dispatch ID, status, and automation flags for safe, non-duplicate delivery.
- **ChatGPT page state:** for extension-created requests, the extension reads the composer and submission controls to verify the prompt. Automatic closing also checks the conversation URL and whether a new assistant response is non-empty. Response content is never stored.
- **Diagnostics:** progress, failure indicators, and console diagnostics remain in your browser, not uploaded to the developer.

The extension uses your signed-in ChatGPT session without reading authentication cookies or passwords or exporting the session.

## Transmission

Sharing navigates a background tab to `https://chatgpt.com/` over HTTPS with only a temporary random dispatch ID in the URL fragment, not the shared URL or prompt. The extension retrieves the prompt from extension-local session state and inserts it into the ChatGPT page's composer **even when automatic submission is disabled**. ChatGPT may read or save drafts before Send; disabling submission does not keep the prompt private from ChatGPT. Enabled submission sends the verified prompt through ChatGPT's normal interface.

OpenAI processes this information under its [privacy policy](https://openai.com/policies/privacy-policy/) and your account settings. ChatGPT may access the linked page; the extension sends only its URL, not a page copy.

There is no developer-operated data server, analytics, advertising, or telemetry. URLs, prompts, preferences, dispatch state, and responses are not sent to the developer or any service other than ChatGPT. Chrome and ChatGPT may independently process browser activity under their own policies; this policy covers the extension.

## Retention and choices

Preferences remain until changed, local extension data is cleared, or the extension is uninstalled. Edit or clear the prompt in Options.

Dispatch payloads are removed on completion, final failure, or target-tab closure. They expire after approximately 15 seconds, or approximately 120 seconds from arming an automatic-close request. Cleanup runs during dispatch handling and service-worker startup; worker suspension may delay removal. Chrome clears session storage when the browser session ends or the extension is disabled, reloaded, or updated.

The ChatGPT navigation URL does not contain the shared URL or prompt. ChatGPT may retain drafts or submitted conversations under its own policies and settings. Clearing extension data, uninstalling, or closing a tab does not delete browser history or ChatGPT data; manage those separately in Chrome and ChatGPT.

Options can disable submission, closing, or tracking cleanup. Submission and closing default to on; saved on/off choices are preserved. Closing requires submission, does not wait for the full answer, and cannot guarantee continued generation.

Do not share confidential URLs, private document links, passwords, access tokens, or sensitive prompts. Cleanup removes only a fixed tracking-parameter list, not sensitive data. Local storage is not a password vault; the extension adds no storage encryption.

## Limited Use

Use and transfer of Chrome API information adheres to the Chrome Web Store User Data Policy, including Limited Use requirements. Information serves only URL sharing and associated prompt, submission, and closing features; transfer to ChatGPT is necessary for that purpose. The developer does not sell it, use it for advertising or creditworthiness decisions, or permit human access through a developer-operated service.

## Contact and changes

Use the developer email on the Chrome Web Store listing for privacy questions. Include private URLs, prompts, authentication data, or conversation content only if needed and you choose to share them for support.

Policy changes will appear here with an updated revision date.
