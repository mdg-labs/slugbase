import { useTranslate } from "@tolgee/react";
import { AppShell, ThemeSwitcher } from "@slugbase/ui";
import { Outlet } from "react-router";

export function AppChrome() {
  const { t } = useTranslate();

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
      <Outlet />
    </AppShell>
  );
}
