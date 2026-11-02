import { IMPORT_MAX_BOOKMARKS, IMPORT_MAX_NEW_NAMES } from "@slugbase/contracts";
import { useTranslation } from "react-i18next";
import { waitOf, type FileRefusal, type ImportFailure } from "./import-api.ts";

/** The most folder and tag names the bookmarks of one import file may name in total, whatever their number (the limit behind `too_many_links`). */
const IMPORT_MAX_NAME_LINKS = 100_000;

/** The sentence for a file that is turned away before a request, in the language of the page. */
export function useFileRefusalMessage(): (refusal: FileRefusal) => string {
  const { t } = useTranslation();
  return (refusal) => (refusal === "unsupported" ? t("data.import.error.unsupported") : t("data.import.error.tooLarge"));
}

/** The sentence for a request that did not go through, in the language of the page. It never repeats the English text of the server's answer. */
export function useImportFailureMessage(): (failure: ImportFailure) => string {
  const { t } = useTranslation();
  return (failure) => {
    switch (failure.kind) {
      case "payloadTooLarge":
        return t("data.import.error.tooLarge");
      case "unsupportedType":
        return t("data.import.error.unsupportedType");
      case "newerVersion":
        return t("data.import.error.newerVersion");
      case "tooManyNewNames":
        return t("data.import.error.tooManyNewNames", { count: IMPORT_MAX_NEW_NAMES });
      case "tooManyBookmarks":
        return t("data.import.error.tooManyBookmarks", { count: IMPORT_MAX_BOOKMARKS });
      case "tooManyAssignments":
        return t("data.import.error.tooManyAssignments", { count: IMPORT_MAX_NAME_LINKS });
      case "invalid":
        return t("data.import.error.invalid");
      case "unreadable":
        return t("data.import.error.unreadable");
      case "network":
        return t("data.import.error.network");
      case "failed":
        return t("data.import.error.failed");
      case "rateLimited": {
        if (failure.seconds === undefined) {
          return t("data.import.error.rateLimited.unknown");
        }
        const wait = waitOf(failure.seconds);
        return wait.unit === "seconds"
          ? t("data.import.error.rateLimited.seconds", { count: wait.count })
          : t("data.import.error.rateLimited.minutes", { count: wait.count });
      }
    }
  };
}
