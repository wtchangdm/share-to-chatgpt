import type { Settings } from "./types";

export const DEFAULT_SETTINGS: Settings = {
  optionalText: `Read the linked page. Start with a brief summary of its main point, key findings, and significance.

Then add only analysis that materially improves my understanding. Consider what is established versus claimed, interpreted, or speculative; the strongest evidence and important limitations; meaningful counterarguments or missing context; and consequential, surprising, overstated, or easily misunderstood points. These are evaluation criteria, not required sections. Include a point only if it changes the takeaway, confidence in it, or understanding of how or why it matters.

Use reliable external sources when needed to verify a consequential claim or resolve an important gap, and cite sources used. Disclose material limits on access to the page rather than inventing its contents.

Briefly include personal relevance or a useful lesson when it adds something specific, using what you know about me without forcing a connection. Recommend the original or follow-up reading only when you can identify substantial value beyond this briefing.

Do not create or update memories or assumptions about me from this link or summary; base any memory or personal-context updates on personal information I provide in substantive follow-up discussion.

Keep the depth proportional to the material. Preserve central findings, essential explanations, and caveats that change the takeaway. Cut low-value or repetitive points rather than compressing useful explanations into dense prose.

Use readable paragraphs or a short list, merging related points. Omit inapplicable categories, generic caveats, repeated conclusions, process preambles, and offers to continue. Do not manufacture false balance.`,
  placement: "append",
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
    placement: value?.placement === "prepend" || value?.placement === "append"
      ? value.placement
      : DEFAULT_SETTINGS.placement,
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
