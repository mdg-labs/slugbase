import { useTranslate } from "@tolgee/react";
import { isRouteErrorResponse, useRouteError } from "react-router";

export function RootErrorBoundary() {
  const { t } = useTranslate();
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? error.statusText
    : error instanceof Error
      ? error.message
      : t("error.boundary.message");

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-sp-6 bg-canvas p-sp-8 font-sans text-fg">
      <h1 className="t-h2">{t("error.boundary.title")}</h1>
      <p className="t-body text-fg-muted">{message}</p>
      <button
        type="button"
        className="rounded-md bg-accent px-sp-6 py-sp-4 text-small font-medium text-accent-fg"
        onClick={() => {
          window.location.reload();
        }}
      >
        {t("error.boundary.retry")}
      </button>
    </div>
  );
}
