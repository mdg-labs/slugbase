import { useTranslation } from "react-i18next";
import { waitOf } from "./import-api.ts";
import type { ExportFailure } from "./export-api.ts";

/** The sentence for an export that did not reach the disk, in the language of the page. It never repeats the English text of the server's answer. */
export function useExportFailureMessage(): (failure: ExportFailure) => string {
  const { t } = useTranslation();
  return (failure) => {
    switch (failure.kind) {
      case "signedOut":
        return t("data.export.error.signedOut");
      case "unavailable":
        return t("data.export.error.unavailable");
      case "tooMany":
        return t("data.export.error.tooMany");
      case "network":
        return t("data.export.error.network");
      case "failed":
        return t("data.export.error.failed");
      case "rateLimited": {
        if (failure.seconds === undefined) {
          return t("data.export.error.rateLimited.unknown");
        }
        const wait = waitOf(failure.seconds);
        return wait.unit === "seconds"
          ? t("data.export.error.rateLimited.seconds", { count: wait.count })
          : t("data.export.error.rateLimited.minutes", { count: wait.count });
      }
    }
  };
}
