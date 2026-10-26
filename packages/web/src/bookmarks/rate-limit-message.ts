import type { TFunction } from "i18next";

const SECONDS_PER_MINUTE = 60;

/** What the member is told when the API asked them to wait `seconds` before another try; the wait is unknown when the API did not say. */
export function rateLimitMessage(t: TFunction, seconds: number | undefined): string {
  if (seconds === undefined) {
    return t("reauth.error.rateLimited.unknown");
  }
  return seconds < SECONDS_PER_MINUTE
    ? t("reauth.error.rateLimited.seconds", { count: seconds })
    : t("reauth.error.rateLimited.minutes", { count: Math.ceil(seconds / SECONDS_PER_MINUTE) });
}
