import { feedbackToast } from "@slugbase/ui/patterns";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { exportFailureOf, fetchExport, saveFile, type ExportRequest } from "./export-api.ts";
import { useExportFailureMessage } from "./export-messages.ts";

export interface ExportDownload {
  /** Whether a download is running. */
  readonly busy: boolean;
  /** Fetches the export and saves it, telling the member in a toast how it went; a second call while one runs does nothing. */
  readonly download: (request: ExportRequest) => Promise<void>;
}

/**
 * The download of an export as the export page and the Delete workspace dialog run it: the file is fetched through the API client and
 * saved from the browser's memory, so a refusal (a rate limit, a failure) is told in a toast with the wait the server asks for, and
 * nothing is saved. It never throws; the toast has told the member why.
 */
export function useExportDownload(): ExportDownload {
  const { t } = useTranslation();
  const api = useRouter().options.context.api;
  const failureMessage = useExportFailureMessage();
  const [busy, setBusy] = useState(false);
  const downloading = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function download(request: ExportRequest): Promise<void> {
    if (downloading.current) {
      return;
    }
    downloading.current = true;
    setBusy(true);
    const followed = feedbackToast.promise(
      fetchExport(api, request).then((file) => {
        saveFile(file);
        return file.fileName;
      }),
      {
        loading: t("data.export.loading"),
        success: (fileName) => ({ title: t("data.export.success"), description: fileName }),
        error: (reason) => ({ title: t("data.export.failure"), description: failureMessage(exportFailureOf(reason)) }),
      },
    );
    try {
      await followed;
    } catch {
      // The toast has told the member why.
    } finally {
      downloading.current = false;
      if (mounted.current) {
        setBusy(false);
      }
    }
  }

  return { busy, download };
}
