import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ExportPanel } from "./export-panel.tsx";
import { ImportWizard } from "./import-wizard.tsx";

/** `/settings/account/data` (doc 03 section 11.5): bringing bookmarks in and taking them out. */
export function AccountDataPage(): ReactElement {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-6">
      <h1 className="font-semibold text-xl">{t("data.title")}</h1>
      <ImportWizard />
      <ExportPanel />
    </div>
  );
}
