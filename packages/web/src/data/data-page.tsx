import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useCachedAccount } from "../account/use-cached-account.ts";
import { ExportPanel, ExportPanelView } from "./export-panel.tsx";
import { ImportWizard } from "./import-wizard.tsx";

/** `/settings/account/data` (doc 03 section 11.5): bringing bookmarks in and taking them out. */
export function AccountDataPage(): ReactElement {
  const { t } = useTranslation();
  const account = useCachedAccount();
  // An account in the export-only access mode (doc 02 section 2.11) takes its data out and brings nothing in: the import is refused, so it is not offered,
  // and the entitlements it would read to offer sharing are refused as well, so the option to include shared bookmarks is offered unasked.
  if (account?.accessMode === "exportOnly") {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="font-semibold text-xl">{t("data.title")}</h1>
        <ExportPanelView offerShared />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      <h1 className="font-semibold text-xl">{t("data.title")}</h1>
      <ImportWizard />
      <ExportPanel />
    </div>
  );
}
