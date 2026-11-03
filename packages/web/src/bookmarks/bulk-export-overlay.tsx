import { Button } from "@slugbase/ui";
import { ChoiceCards, FormOverlay, type ChoiceCardOption } from "@slugbase/ui/patterns";
import { useState, type ReactElement, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import type { ExportFormat } from "../data/export-api.ts";

const FORMATS: readonly ExportFormat[] = ["json", "netscape"];

function isExportFormat(value: string): value is ExportFormat {
  return FORMATS.some((format) => format === value);
}

export interface BulkExportOverlayProps {
  /** How many bookmarks are selected, which the title states. */
  readonly count: number;
  /** Whether the export names the filters of the list and not the bookmarks: it then holds every bookmark that matches when it runs. */
  readonly byFilters: boolean;
  /** Called with the format chosen; the caller runs the export and closes the overlay. */
  readonly onSubmit: (format: ExportFormat) => void;
  readonly onClose: () => void;
}

/**
 * What the member chooses for the export of the selection (doc 03 section 3.4, doc 02 section 5.8): SlugBase JSON or a browser
 * bookmark file, the two formats of the export of the whole library.
 */
export function BulkExportOverlay({ count, byFilters, onSubmit, onClose }: BulkExportOverlayProps): ReactElement {
  const { t } = useTranslation();
  const [format, setFormat] = useState<ExportFormat>("json");
  const options: readonly ChoiceCardOption[] = [
    { value: "json", label: t("data.export.format.json.label"), description: t("data.export.format.json.description") },
    { value: "netscape", label: t("data.export.format.netscape.label"), description: t("data.export.format.netscape.description") },
  ];
  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    onSubmit(format);
  };
  return (
    <FormOverlay
      closeLabel={t("bookmarks.bulk.export.close")}
      description={t(byFilters ? "bookmarks.bulk.export.descriptionFilters" : "bookmarks.bulk.export.description")}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
      title={t("bookmarks.bulk.export.title", { count })}
    >
      <form className="flex flex-col gap-4" noValidate onSubmit={submit}>
        <ChoiceCards
          label={t("data.export.format.label")}
          onValueChange={(next) => {
            if (isExportFormat(next)) {
              setFormat(next);
            }
          }}
          options={options}
          value={format}
        />
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button onClick={onClose} type="button" variant="outline">
            {t("bookmarks.bulk.export.cancel")}
          </Button>
          <Button type="submit">{t("bookmarks.bulk.export.confirm")}</Button>
        </div>
      </form>
    </FormOverlay>
  );
}
