import { useTranslate } from "@tolgee/react";
import { ThemeSwitcher, AppShell } from "@slugbase/ui";
import { useRouteError } from "react-router";
import { AppErrorPage } from "./AppErrorPage.js";
import { resolveRouteErrorStatus } from "./resolve-route-error-status.js";

export function AppShellErrorBoundary() {
  const { t } = useTranslate();
  const error = useRouteError();
  const status = resolveRouteErrorStatus(error);

  return (
    <AppShell
      brandLabel={t("app.shell.brand")}
      workspaceLabel={t("app.shell.workspace_default")}
      headerActions={
        <ThemeSwitcher
          labels={{
            group: t("theme.switcher.group"),
            light: t("theme.switcher.light"),
            dark: t("theme.switcher.dark"),
            auto: t("theme.switcher.auto"),
          }}
        />
      }
    >
      <AppErrorPage status={status} error={error} />
    </AppShell>
  );
}
