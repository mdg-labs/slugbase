import { Loading } from "@slugbase/ui/patterns";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

/** What a route shows while its page is on its way. */
export function RoutePending(): ReactElement {
  const { t } = useTranslation();
  return <Loading label={t("shell.loading")} />;
}
