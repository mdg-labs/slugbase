import { Button } from "@slugbase/ui";
import { CheckboxField, ChoiceCards, DownloadIcon, SettingsSection, feedbackToast, type ChoiceCardOption } from "@slugbase/ui/patterns";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useIsGranted } from "../entitlements/index.ts";
import { exportFailureOf, fetchExport, saveFile, type ExportFormat } from "./export-api.ts";
import { useExportFailureMessage } from "./export-messages.ts";

const FORMATS: readonly ExportFormat[] = ["json", "netscape"];

function isExportFormat(value: string): value is ExportFormat {
  return FORMATS.some((format) => format === value);
}

/**
 * The export of doc 03 section 11.5: choose SlugBase JSON or a browser bookmark file, optionally with the bookmarks shared with the
 * member, and download it. The file is fetched through the API client and saved from the browser's memory, so a refusal (a rate
 * limit, a failure) is told in a toast with the wait the server asks for, and nothing is saved.
 */
export function ExportPanel(): ReactElement {
  const { t } = useTranslation();
  const api = useRouter().options.context.api;
  const failureMessage = useExportFailureMessage();
  const sharesWithMembers = useIsGranted("sharing.members");
  const sharesWithTeams = useIsGranted("sharing.teams");
  const mayShare = sharesWithMembers || sharesWithTeams;

  const [format, setFormat] = useState<ExportFormat>("json");
  const [includeShared, setIncludeShared] = useState(false);
  const [busy, setBusy] = useState(false);
  const downloading = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function download(): Promise<void> {
    if (downloading.current) {
      return;
    }
    downloading.current = true;
    setBusy(true);
    const followed = feedbackToast.promise(
      fetchExport(api, { format, includeShared: mayShare && includeShared }).then((file) => {
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

  const formatOptions: readonly ChoiceCardOption[] = [
    { value: "json", label: t("data.export.format.json.label"), description: t("data.export.format.json.description") },
    { value: "netscape", label: t("data.export.format.netscape.label"), description: t("data.export.format.netscape.description") },
  ];

  return (
    <SettingsSection
      description={t("data.export.description")}
      footer={
        <Button
          loading={busy}
          onClick={() => {
            void download();
          }}
        >
          <DownloadIcon aria-hidden="true" />
          {t("data.export.download")}
        </Button>
      }
      title={t("data.export.title")}
    >
      <div className="flex flex-col gap-4">
        <ChoiceCards
          label={t("data.export.format.label")}
          onValueChange={(next) => {
            if (isExportFormat(next)) {
              setFormat(next);
            }
          }}
          options={formatOptions}
          value={format}
        />
        {mayShare ? <CheckboxField checked={includeShared} label={t("data.export.includeShared")} onCheckedChange={setIncludeShared} /> : null}
      </div>
    </SettingsSection>
  );
}
