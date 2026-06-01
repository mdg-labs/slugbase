/** Supported UI locales (spec §17). */
export type AppLocale = "en" | "de";

export const SUPPORTED_APP_LOCALES: readonly AppLocale[] = ["en", "de"];

export function isAppLocale(value: string | null | undefined): value is AppLocale {
  return value === "en" || value === "de";
}

/**
 * Parse the first supported language from an Accept-Language header.
 * Quality values are respected when choosing between en and de.
 */
export function parseAcceptLanguage(header: string | null | undefined): AppLocale | null {
  if (!header) return null;

  const candidates: { locale: AppLocale; quality: number; index: number }[] = [];

  for (const [index, part] of header.split(",").entries()) {
    const [rawTag, ...params] = part.trim().split(";");
    const tag = rawTag?.trim().toLowerCase();
    if (!tag) continue;

    const locale: AppLocale | null = tag.startsWith("de")
      ? "de"
      : tag.startsWith("en")
        ? "en"
        : null;
    if (!locale) continue;

    const qParam = params.find((param) => param.trim().startsWith("q="));
    const quality = qParam ? Number.parseFloat(qParam.trim().slice(2)) : 1;
    candidates.push({
      locale,
      quality: Number.isFinite(quality) ? quality : 0,
      index,
    });
  }

  if (candidates.length === 0) return null;

  candidates.sort((left, right) => {
    if (right.quality !== left.quality) return right.quality - left.quality;
    return left.index - right.index;
  });

  return candidates[0]?.locale ?? null;
}

/**
 * Resolve the active UI locale (spec §17):
 * signed-in user preference → Accept-Language → fallback `en`.
 */
export function resolveLocale(options: {
  userLanguage?: string | null;
  acceptLanguage?: string | null;
}): AppLocale {
  if (isAppLocale(options.userLanguage)) {
    return options.userLanguage;
  }

  const fromHeader = parseAcceptLanguage(options.acceptLanguage);
  if (fromHeader) return fromHeader;

  return "en";
}
