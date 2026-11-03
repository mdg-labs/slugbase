import { Button } from "@slugbase/ui";
import { DownloadIcon, GroupedResults, MetricTile, type GroupedResultsGroup } from "@slugbase/ui/patterns";
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useFormat } from "../i18n/use-format.ts";
import type { ImportResult } from "./import-api.ts";
import { saveImportReport } from "./import-report.ts";

type Skipped = ImportResult["skipped"][number];
type Failed = ImportResult["failed"][number];
type Dropped = ImportResult["droppedSlugs"][number];

interface Entry {
  readonly position: number;
  readonly title: string;
  readonly url: string;
  readonly slug?: string;
}

/** Every title, address and slug comes from the file, so each is text in the element and never a link or markup (T14). */
function Entries({ entries }: { readonly entries: readonly Entry[] }): ReactElement {
  const { t } = useTranslation();
  return (
    <ul className="flex flex-col divide-y">
      {entries.map((entry) => (
        <li className="flex min-w-0 flex-col gap-0.5 py-2" key={`${String(entry.position)}-${entry.url}-${entry.slug ?? ""}`}>
          <span className="break-words font-medium text-foreground">{entry.title === "" ? entry.url : entry.title}</span>
          {entry.title === "" ? null : <span className="break-all">{entry.url}</span>}
          {entry.slug === undefined ? null : <span className="break-all">{t("data.import.result.entry.slug", { slug: entry.slug })}</span>}
          <span className="text-xs">{t("data.import.result.entry.position", { position: entry.position })}</span>
        </li>
      ))}
    </ul>
  );
}

function entriesOf(list: readonly (Skipped | Failed | Dropped)[], reason: string): Entry[] {
  return list.filter((entry) => entry.reason === reason).map((entry) => ({ position: entry.position, title: entry.title, url: entry.url, ...("slug" in entry ? { slug: entry.slug } : {}) }));
}

/**
 * What an import did (doc 03 section 11.5): the counts, the bookmarks it left out grouped by the reason, and a JSON report of the whole
 * result that is made in the browser. A group without entries is not shown, and a result with nothing left out says so.
 */
export function ImportResultView({ result, checklistNotUpdated }: { readonly result: ImportResult; readonly checklistNotUpdated: boolean }): ReactElement {
  const { t } = useTranslation();
  const format = useFormat();
  const [downloadFailed, setDownloadFailed] = useState(false);

  const groupOf = (id: string, label: string, entries: readonly Entry[]): GroupedResultsGroup => ({
    id,
    label,
    count: entries.length,
    countLabel: format.number(entries.length),
    children: <Entries entries={entries} />,
  });
  const groups = [
    groupOf("skipped-duplicate", t("data.import.result.groups.skipped.duplicate"), entriesOf(result.skipped, "duplicate")),
    groupOf("skipped-limit", t("data.import.result.groups.skipped.limit"), entriesOf(result.skipped, "bookmark_limit_reached")),
    groupOf("failed-url-not-allowed", t("data.import.result.groups.failed.urlNotAllowed"), entriesOf(result.failed, "url_not_allowed")),
    groupOf("failed-url-invalid", t("data.import.result.groups.failed.urlInvalid"), entriesOf(result.failed, "url_invalid")),
    groupOf("slugs-invalid", t("data.import.result.groups.slugs.invalid"), entriesOf(result.droppedSlugs, "slug_invalid")),
    groupOf("slugs-conflict", t("data.import.result.groups.slugs.conflict"), entriesOf(result.droppedSlugs, "slug_conflict")),
  ];
  const nothingLeftOut = result.skipped.length === 0 && result.failed.length === 0;

  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <MetricTile label={t("data.import.result.created")} value={format.number(result.created)} />
        <MetricTile label={t("data.import.result.skipped")} value={format.number(result.skipped.length)} />
        <MetricTile label={t("data.import.result.failed")} value={format.number(result.failed.length)} />
        <MetricTile label={t("data.import.result.slugsDropped")} value={format.number(result.slugsDropped)} />
      </div>
      <p className="text-muted-foreground text-sm">{t("data.import.result.made", { folders: result.foldersCreated, tags: result.tagsCreated })}</p>
      {nothingLeftOut ? <p className="text-sm">{t("data.import.result.nothingLeftOut")}</p> : null}
      <GroupedResults groups={groups} />
      {checklistNotUpdated ? (
        <p className="text-destructive-text text-sm" role="alert">
          {t("data.import.result.checklistNotUpdated")}
        </p>
      ) : null}
      <div className="flex flex-col items-start gap-2">
        <Button
          onClick={() => {
            try {
              saveImportReport(result);
              setDownloadFailed(false);
            } catch {
              setDownloadFailed(true);
            }
          }}
          size="sm"
          variant="outline"
        >
          <DownloadIcon aria-hidden="true" />
          {t("data.import.result.download")}
        </Button>
        {downloadFailed ? (
          <p className="text-destructive-text text-sm" role="alert">
            {t("data.import.result.downloadFailed")}
          </p>
        ) : null}
      </div>
    </>
  );
}
