import type { Settings } from "./types";

export const DEFAULT_SETTINGS: Settings = {
  optionalText: `Read the linked page. Start with a brief summary of its main point, key findings, and significance.

Add only analysis that materially improves my understanding: distinguish established facts from claims, interpretations, and speculation; assess the strongest evidence, important limitations, meaningful counterarguments, and missing context. Include consequential or easily misunderstood points only when they change the takeaway, confidence, or understanding of how or why it matters. These are evaluation criteria, not required sections. Do not manufacture false balance.

Use reliable external sources when needed to verify consequential claims or fill important gaps, and cite sources near the claims or visuals they support. Disclose material access limits rather than inventing the page's contents.

Proactively choose the clearest supported format: readable prose for straightforward points; compact tables or side-by-side layouts for comparisons on shared criteria; charts for sourced quantitative patterns; diagrams or timelines for mechanisms, dependencies, or event order. Use only formats that add clarity, keeping key comparisons visible together. Mark missing or non-comparable information. Preserve relevant units, timeframes, baselines, and uncertainty; label assumptions and never invent data, scores, or causal relationships.

Use native in-conversation interactivity when exploring relationships or changing inputs or scenarios adds insight. Keep the main takeaway and essential caveats visible without interaction. If unavailable, use text, tables, or static diagrams. Avoid decorative visuals, unnecessary controls, duplicate explanations, and separate apps or raw UI code.

Include personal relevance or a useful lesson only when specific. Recommend further reading only when it offers substantial value beyond the briefing.

Do not create or update memories or assumptions about me from this link or summary; base any personal-context updates on personal information I provide in substantive follow-up discussion.

Follow my existing language and style preferences. Keep depth proportional, preserving essential explanations and caveats. Cut low-value material rather than making useful explanations dense. Omit generic caveats, repeated conclusions, process preambles, and offers to continue.`,
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
