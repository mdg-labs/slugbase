import { Button } from "@slugbase/ui";
import { CheckboxField, ChoiceCards, DownloadIcon, SettingsSection, type ChoiceCardOption } from "@slugbase/ui/patterns";
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useIsGranted } from "../entitlements/index.ts";
import type { ExportFormat } from "./export-api.ts";
import { useExportDownload } from "./use-export-download.ts";

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
  const sharesWithMembers = useIsGranted("sharing.members");
  const sharesWithTeams = useIsGranted("sharing.teams");
  return <ExportPanelView offerShared={sharesWithMembers || sharesWithTeams} />;
}

/** The export panel with the choice of including shared bookmarks decided by the caller, which reads no entitlement. */
export function ExportPanelView({ offerShared: mayShare }: { offerShared: boolean }): ReactElement {
  const { t } = useTranslation();
  const { busy, download } = useExportDownload();

  const [format, setFormat] = useState<ExportFormat>("json");
  const [includeShared, setIncludeShared] = useState(false);

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
            void download({ format, includeShared: mayShare && includeShared });
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
