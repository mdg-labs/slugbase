// The user-agent family the session list shows (doc 02 section 2.4): a browser or
// client name read from the stored header, never the header itself. The order is
// the order of the tokens a browser adds: Edge, Opera and Chrome-based browsers all
// say "Chrome" and "Safari" too, and Chrome says "Safari".
const FAMILIES: readonly (readonly [RegExp, string])[] = [
  [/\b(?:Edg|EdgA|EdgiOS|Edge)\//, "Edge"],
  [/\b(?:OPR|OPT)\/|\bOpera\b/, "Opera"],
  [/\b(?:Firefox|FxiOS)\//, "Firefox"],
  [/\b(?:Chrome|CriOS|Chromium)\//, "Chrome"],
  [/\bSafari\//, "Safari"],
  [/^curl\//, "curl"],
];

const OTHER = "Other";

/** The family of a stored user agent; null when the client sent none, "Other" for a family not listed. */
export function userAgentFamily(userAgent: string | null): string | null {
  if (userAgent === null || userAgent.trim() === "") {
    return null;
  }
  return FAMILIES.find(([pattern]) => pattern.test(userAgent))?.[1] ?? OTHER;
}
