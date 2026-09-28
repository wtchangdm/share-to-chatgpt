import type { Settings } from "./types";

export const DEFAULT_SETTINGS: Settings = {
  optionalText: `Start with a brief summary of the key takeaways, then analyze the page.

Distinguish what is established, what the page asserts or interprets, and what is speculative. Assess the strongest evidence and important caveats, and include meaningful counterarguments or missing context when relevant. Add external context or verification only when it materially improves understanding, using reliable sources and citing them.

Explain why it matters in context, and call out anything important, surprising, overstated, weakly supported, or easy to misunderstand. Suggest worthwhile follow-up reading only when useful.

Finally, tell me why this may matter to me, what I can learn from it, and recommend reading the original only if it adds substantial value beyond the summary.

Keep the depth proportional to the material. Don't manufacture false balance or turn a simple page into a long essay.`,
  placement: "prepend",
  stripTrackingParameters: true,
  autoSubmit: true,
  autoClose: true
};

const CHATGPT_BASE_URL = "https://chatgpt.com/";

const TRACKING_QUERY_PARAMETERS = [
  "utm_id",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_source_platform",
  "utm_term",
  "utm_content",
  "utm_creative_format",
  "utm_marketing_tactic",
  "gclid",
  "dclid",
  "gbraid",
  "wbraid",
  "gad_source",
  "gad_campaignid",
  "srsltid",
  "fbclid",
  "msclkid",
  "ttclid",
  "li_fat_id",
  "mc_cid",
  "mc_eid",
  "mc_tc"
] as const;

const TRACKING_QUERY_PARAMETER_SET: ReadonlySet<string> =
  new Set(TRACKING_QUERY_PARAMETERS);

function decodeQueryParameterName(value: string): string {
  if (!value.includes("%") && !value.includes("+")) {
    return value;
  }

  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

export function stripCommonTrackingParameters(value: string): string {
  const queryStart = value.indexOf("?");
  if (queryStart === -1) {
    return value;
  }

  const fragmentStart = value.indexOf("#");
  if (fragmentStart !== -1 && fragmentStart < queryStart) {
    return value;
  }

  const queryEnd = fragmentStart === -1 ? value.length : fragmentStart;
  const retainedFields: string[] = [];
  let changed = false;

  for (const field of value.slice(queryStart + 1, queryEnd).split("&")) {
    const equalsIndex = field.indexOf("=");
    const encodedName = equalsIndex === -1 ? field : field.slice(0, equalsIndex);
    const name = decodeQueryParameterName(encodedName);
    if (TRACKING_QUERY_PARAMETER_SET.has(name)) {
      changed = true;
    } else {
      retainedFields.push(field);
    }
  }

  if (!changed) {
    return value;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(value);
  } catch {
    return value;
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return value;
  }

  const hasRetainedField = retainedFields.some((field) => field.length > 0);
  const retainedQuery = hasRetainedField ? `?${retainedFields.join("&")}` : "";
  return value.slice(0, queryStart) + retainedQuery + value.slice(queryEnd);
}

export function normalizeSettings(value: Partial<Settings> | undefined): Settings {
  return {
    optionalText: typeof value?.optionalText === "string"
      ? value.optionalText
      : DEFAULT_SETTINGS.optionalText,
    placement: value?.placement === "append" ? "append" : "prepend",
    stripTrackingParameters: value?.stripTrackingParameters !== false,
    autoSubmit: value?.autoSubmit !== false,
    autoClose: value?.autoClose === undefined ? DEFAULT_SETTINGS.autoClose : value.autoClose === true
  };
}

export function buildPrompt(
  url: string,
  settings: Pick<Settings, "optionalText" | "placement"> &
    Partial<Pick<Settings, "stripTrackingParameters">>
): string {
  const targetUrl = settings.stripTrackingParameters === false
    ? url
    : stripCommonTrackingParameters(url);
  const optionalText = settings.optionalText
    .trim()
    .replace(/\r\n?/g, "\n");
  if (!optionalText) {
    return targetUrl;
  }

  return settings.placement === "append"
    ? `${targetUrl}\n\n${optionalText}`
    : `${optionalText} ${targetUrl}`;
}

export function buildChatGPTUrl(prompt: string, dispatchId?: string): string {
  const deepLink = `${CHATGPT_BASE_URL}?prompt=${encodeURIComponent(prompt)}`;
  return dispatchId
    ? `${deepLink}#share-to-chatgpt-dispatch=${encodeURIComponent(dispatchId)}`
    : deepLink;
}
