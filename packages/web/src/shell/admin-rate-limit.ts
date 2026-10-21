import { useTranslation } from "react-i18next";

const SECONDS_PER_MINUTE = 60;

/** The sentence for a `429`, naming the wait the server asked for when it named one. */
export function useRateLimitMessage(): (seconds: number | undefined) => string {
  const { t } = useTranslation();
  return (seconds) => {
    if (seconds === undefined) {
      return t("reauth.error.rateLimited.unknown");
    }
    return seconds < SECONDS_PER_MINUTE
      ? t("reauth.error.rateLimited.seconds", { count: seconds })
      : t("reauth.error.rateLimited.minutes", { count: Math.ceil(seconds / SECONDS_PER_MINUTE) });
  };
}
