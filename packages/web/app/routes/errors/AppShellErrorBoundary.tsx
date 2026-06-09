import { useTranslation } from "react-i18next";
import { ThemeSwitcher, AppShell } from "@slugbase/ui";
import { useEffect } from "react";
import { useNavigate, useRouteError } from "react-router";
import { AppErrorPage } from "./AppErrorPage.js";
import { resolveRouteErrorStatus } from "./resolve-route-error-status.js";

export function AppShellErrorBoundary() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const error = useRouteError();
  const status = resolveRouteErrorStatus(error);

  useEffect(() => {
    if (status === 401) {
      void navigate("/login", { replace: true });
    }
  }, [status, navigate]);

  if (status === 401) return null;

  return (
    <AppShell
      sidebar={
        <div className="flex items-center gap-sp-4 m-sp-4 px-sp-3 py-sp-3">
          <span className="font-semibold text-[length:var(--text-body)] text-fg">
            {t("app.shell.brand")}
          </span>
        </div>
      }
      topBar={
        <div className="flex w-full items-center justify-end px-sp-6">
          <ThemeSwitcher
            labels={{
              group: t("theme.switcher.group"),
              light: t("theme.switcher.light"),
              dark: t("theme.switcher.dark"),
              auto: t("theme.switcher.auto"),
            }}
          />
        </div>
      }
    >
      <AppErrorPage status={status} error={error} />
    </AppShell>
  );
}
