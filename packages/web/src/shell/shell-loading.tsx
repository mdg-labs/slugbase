import { Loading } from "@slugbase/ui/patterns";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

/** What shows while `/api/config` is on its way. Needs the i18n provider, not the configuration. */
export function ShellLoading(): ReactElement {
  const { t } = useTranslation();
  return <Loading className="mx-auto min-h-svh max-w-3xl" label={t("shell.loading")} />;
}
