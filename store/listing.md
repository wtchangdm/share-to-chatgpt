# Chrome Web Store listing copy

Prepared for unlisted version 0.1.0; not publication or approval evidence. Review declarations against the final build before certifying. Release workflow and authorization gates: [AGENTS.md](../AGENTS.md#chrome-web-store-release-preparation).

## Store listing

- **Name:** Share to ChatGPT
- **Summary:** Send the current page or a link to ChatGPT in a background tab.
- **Language:** English
- **Suggested category:** Productivity, or the closest dashboard category.

### Detailed description

Send a page or link URL with a customizable prompt to ChatGPT in a background tab, using your signed-in session without leaving your reading tab. The extension sends the URL, not a page copy; ChatGPT's access depends on the page and your session.

Share using the toolbar, the “Send link to ChatGPT” link context menu, or Command+B (macOS) / Ctrl+B (other platforms). The shortcut shares the hovered link, falling back to the current page; customize or disable it at chrome://extensions/shortcuts.

In Options:
- Use the included summary-and-analysis prompt, customize it, or leave it empty for URL-only sharing. Place it before or after the URL, preserving line breaks.
- Remove common tracking parameters while preserving other URL data; disable cleanup for signed or single-use links if needed.
- Automatically submit a verified prompt, or prefill without submitting.
- Optionally close after a conversation URL and response-start signal appear. Closing defaults to on for unsaved settings; it does not wait for the full answer or guarantee continued generation.

To start, install and pin the extension, sign in to chatgpt.com, and open Options from the extension icon's context menu. Review preferences before sharing a public page or link.

**Privacy:** Sharing sends the URL and prompt to ChatGPT over HTTPS even with submission off. Preferences stay local; delivery state is temporary. There is no developer data server, telemetry, advertising, or data sales, and assistant responses are never stored. Avoid confidential URLs and sensitive prompts; tracking cleanup is not a sensitive-data scrubber. See the linked privacy policy.

**Compatibility:** Chrome 120+ and a signed-in ChatGPT session required. No API key; normal ChatGPT limits apply. This independent extension is not affiliated with or endorsed by OpenAI. ChatGPT's interface can change; unverifiable prompts or controls leave the tab open without uncertain submission.

### Images

| Asset | Requirements |
| --- | --- |
| `icons/icon128.png` | 128×128 PNG; 96×96 artwork with transparent padding. |
| `store/promo-440x280.png` | 440×280 PNG; source: `store/promo.svg`. |
| `store/screenshot-options.png` | 1280×800 PNG from the real Options page, default settings, isolated browser; no conversation or personal data. Caption: “Customize your prompt, link cleanup, and submission preferences.” |

## Privacy practices

### Single purpose

Send a user-selected page or link URL with a customizable prompt to ChatGPT in a background tab, with optional verified submission and automatic closing.

### Permission justifications

| Permission | Dashboard justification |
| --- | --- |
| `activeTab` | Temporarily access the active page on user invocation for its URL and shortcut-triggered hovered-link lookup; no persistent all-sites access. |
| `contextMenus` | Add “Send link to ChatGPT” to share a selected link URL. |
| `scripting` | Look up the hovered link in the active page's main frame only when the shortcut is invoked, using activeTab access. |
| `storage` | Keep prompt/preferences locally and temporary session dispatch/tab-status state for target-tab binding, duplicate prevention, and completion/failure cleanup. |
| `https://chatgpt.com/*` | Run packaged content scripts for extension-marked requests: verify/insert the exact prompt, optionally submit through page controls, and observe conversation/response-start signals before optional closure. Unmarked tabs are not automated. |

### Remote code

Select **No, I am not using remote code**. All executable extension code is packaged; normal ChatGPT DOM interaction uses no downloaded executable code, eval, or private APIs.

### Data disclosures

Do **not** select “I do not collect or use user data”: URLs and prompts are handled and transmitted without a developer server. Check current dashboard definitions before declaring:

- **Web history:** only the page/link URL explicitly shared, not all browsing.
- **Website content:** user prompts and composer contents; assistant content is checked locally only for non-emptiness during automatic closing, never stored.
- **Personal communications:** ChatGPT prompts and the limited response-presence check; no background collection of unrelated conversations.

No separate collection of identity, payment, health, authentication, location, or interaction-tracking data. User URLs/prompts may contain sensitive information; do not claim arbitrary input is sanitized.

Certify only after checking the final implementation and policy:
- No sale or transfer outside permitted uses; ChatGPT transfer serves the single purpose.
- No use or transfer unrelated to that purpose.
- No use or transfer for creditworthiness or lending.

### Privacy policy URL

With authorization, publish `PRIVACY.md` at a stable public HTTPS URL and verify signed-out access before entering it in the dashboard. A public repository's rendered file is sufficient. No store policy URL has been selected or verified.

## Reviewer test instructions

Requires Chrome 120+ and the reviewer's signed-in ChatGPT account. No extension account, API key, or developer credentials required. Do not supply passwords or cookies.

1. Sign in to https://chatgpt.com/. In Options, set Prompt to `Reply with only OK.`, keep submission on, and turn closing off (both default on).
2. Open https://example.com/ and click the toolbar once. The source stays selected; one background tab submits one prompt containing the URL and instruction, then stays open.
3. Test a public link's context menu and the shortcut with/without a hovered link. Each invocation shares the intended URL once. If Chrome reserves the shortcut, assign another at chrome://extensions/shortcuts.
4. Disable submission and share: prefill only, though navigation still sends the prompt to ChatGPT.
5. Enable submission and closing; share again. Close only after the documented conversation/response signals; uncertainty or timeout leaves the tab open. Reopen from ChatGPT history and verify a response.
6. Confirm unrelated ChatGPT tabs are not auto-submitted; logged-out or missing-composer states must not submit uncertain content.
7. Restore desired settings. Keep conversation content out of review logs.

This sequence does not replace the [release regression checklist](../spec.md#manual-regression-checklist).

## Distribution and authorization

- **Visibility:** Unlisted; anyone with the link can install, not an allowlist.
- **Pricing:** Free; ChatGPT access is separate.
- **Regions:** Publisher choice, covering intended recipients.
- **Automatic publication after review:** Disable for the first submission; publication is a separate decision.
- **Publisher name/contact:** Supply and verify in the developer account.
- **Homepage/support:** Optional; verify public access and enabled support. Do not invent a store URL or item ID.

Fees, policy publication, uploads, submission, and publication require explicit authorization. Repository commits/pushes do not grant store authorization.

Official references: [preparation](https://developer.chrome.com/docs/webstore/prepare), [images](https://developer.chrome.com/docs/webstore/images), [privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy), [user data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), [distribution](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution).
