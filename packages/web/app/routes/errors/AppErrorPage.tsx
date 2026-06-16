import { useTranslation } from "react-i18next";
import { Button } from "@slugbase/ui";
import { useCallback, useEffect, useState } from "react";
import { Link, useLocation } from "react-router";
import { isAnalyticsConsentGranted } from "../../components/consent/consent-storage.js";
import { captureClientException } from "../../lib/error-reporting-client.js";
import { formatDocumentTitle } from "../../lib/format-document-title.js";
import { resolveErrorPageTitleKey } from "../../lib/resolve-page-title.js";
import type { SupportedLocale } from "../../i18n/messages.js";
import type { AppErrorStatus } from "./error-status.js";

type AppErrorPageProps = {
  status: AppErrorStatus;
  error?: unknown;
};

const statusTitleKey: Record<AppErrorStatus, string> = {
  404: "error.page.404.title",
  403: "error.page.403.title",
  401: "error.page.401.title",
  500: "error.page.500.title",
  503: "error.page.503.title",
};

const statusDescriptionKey: Record<AppErrorStatus, string> = {
  404: "error.page.404.description",
  403: "error.page.403.description",
  401: "error.page.401.description",
  500: "error.page.500.description",
  503: "error.page.503.description",
};

const primaryActionKey: Record<AppErrorStatus, string> = {
  404: "error.page.action.bookmarks",
  403: "error.page.action.workspace",
  401: "error.page.action.reload",
  500: "error.page.action.reload",
  503: "error.page.action.retry",
};

export function AppErrorPage({ status, error }: AppErrorPageProps) {
  const { t, i18n } = useTranslation();
  const location = useLocation();
  const [reported, setReported] = useState(false);

  useEffect(() => {
    const locale = i18n.language as SupportedLocale;
    document.title = formatDocumentTitle(locale, resolveErrorPageTitleKey(status));
  }, [i18n.language, status]);

  const showPath = status === 404 && location.pathname.length > 1;
  const primaryHref = status === 401 ? "/login" : status === 403 ? "/" : "/bookmarks";
  const useButton = status === 500 || status === 503;

  const handleReport = useCallback(() => {
    captureClientException(error ?? new Error(`App error ${String(status)}`), {
      consentGranted: isAnalyticsConsentGranted(),
    });
    setReported(true);
  }, [error, status]);

  const handleReload = useCallback(() => {
    window.location.reload();
  }, []);

  const handleBack = useCallback(() => {
    window.history.back();
  }, []);

  return (
    <section
      className="flex flex-1 flex-col items-center justify-center gap-sp-6 px-sp-9 py-sp-12 text-center"
      aria-labelledby="app-error-title"
    >
      <div className="error-mark" aria-hidden="true">
        <img src="/slugbase_icon.svg" alt="" width={64} height={64} />
      </div>
      <p className="error-code" aria-hidden="true">
        {status}
      </p>
      <h1 id="app-error-title" className="error-title">
        {t(statusTitleKey[status])}
      </h1>
      <p className="error-desc">{t(statusDescriptionKey[status])}</p>
      {showPath ? (
        <p className="error-path" aria-label={t("error.page.path_label")}>
          {location.pathname}
        </p>
      ) : null}
      <div className="error-actions">
        {useButton ? (
          <Button variant="primary" onClick={handleReload}>
            {t(primaryActionKey[status])}
          </Button>
        ) : (
          <Link
            to={primaryHref}
            className="inline-flex items-center justify-center gap-sp-3 rounded-md border border-[color:var(--accent-border)] bg-accent px-sp-5 py-sp-3 font-medium text-accent-fg transition-colors duration-micro ease-in-out hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
            style={{ fontSize: "var(--text-body)", lineHeight: "var(--lh-body)" }}
          >
            {t(primaryActionKey[status])}
          </Link>
        )}
        {!useButton && status !== 401 ? (
          <Button variant="secondary" onClick={handleBack}>
            {t("error.page.action.back")}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          className="text-small"
          onClick={handleReport}
          aria-live="polite"
        >
          {reported ? t("error.page.report_done") : t("error.page.report")}
        </Button>
      </div>
    </section>
  );
}
