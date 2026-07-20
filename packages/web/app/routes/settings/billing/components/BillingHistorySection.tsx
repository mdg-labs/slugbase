import { useTranslation } from "react-i18next";
import { Button } from "@slugbase/ui";
import { useEffect, useState } from "react";

import { useAppLocale } from "../../../../i18n/use-app-locale.js";
import { fetchBillingInvoices } from "../billing-api.js";
import { hasPaidAccess } from "../billing-entitlements.js";
import type { BillingInvoice, BillingWorkspaceSummary } from "../billing.types.js";

interface BillingHistorySectionProps {
  workspace: BillingWorkspaceSummary;
  canManage: boolean;
  busy: boolean;
  onUpdatePaymentMethod: () => void;
}

function formatInvoiceDate(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatInvoiceAmount(amount: number, currency: string, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(amount / 100);
}

function invoiceStatusKey(status: BillingInvoice["status"]): string {
  return `settings.billing.invoices_status_${status}`;
}

export function BillingHistorySection({
  workspace,
  canManage,
  busy,
  onUpdatePaymentMethod,
}: BillingHistorySectionProps) {
  const { t } = useTranslation();
  const locale = useAppLocale();
  const hasBillingHistory = hasPaidAccess(workspace) && Boolean(workspace.billingCustomerId);
  const [invoices, setInvoices] = useState<BillingInvoice[]>([]);
  const [invoicesLoading, setInvoicesLoading] = useState(false);
  const [invoicesError, setInvoicesError] = useState<string | null>(null);

  useEffect(() => {
    if (!hasBillingHistory) {
      setInvoices([]);
      setInvoicesError(null);
      setInvoicesLoading(false);
      return;
    }

    let cancelled = false;
    setInvoicesLoading(true);
    setInvoicesError(null);

    void fetchBillingInvoices(workspace.id)
      .then((result) => {
        if (cancelled) return;
        setInvoices(result.items);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setInvoices([]);
        setInvoicesError(
          err instanceof Error ? err.message : t("settings.billing.invoices_error"),
        );
      })
      .finally(() => {
        if (!cancelled) {
          setInvoicesLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [hasBillingHistory, workspace.id, t]);

  return (
    <div className="flex flex-col gap-sp-8" data-testid="billing-history-section">
      <section className="rounded-lg border border-[color:var(--border-subtle)] bg-raised p-sp-6">
        <h3 className="m-0 text-[length:var(--text-body)] font-semibold text-fg">
          {t("settings.billing.history_payment_heading")}
        </h3>
        <p className="mt-sp-2 text-[length:var(--text-small)] text-fg-muted">
          {t("settings.billing.history_payment_body")}
        </p>
        {hasBillingHistory ? (
          <p className="mt-sp-5 text-[length:var(--text-body)] text-fg-muted">
            {t("settings.billing.history_payment_update")}
          </p>
        ) : (
          <p className="mt-sp-5 text-[length:var(--text-body)] text-fg-subtle">
            {t("settings.billing.history_payment_empty")}
          </p>
        )}
      </section>

      <section className="rounded-lg border border-[color:var(--border-subtle)] bg-raised p-sp-6">
        <h3 className="m-0 text-[length:var(--text-body)] font-semibold text-fg">
          {t("settings.billing.history_invoices_heading")}
        </h3>
        <p className="mt-sp-2 text-[length:var(--text-small)] text-fg-muted">
          {t("settings.billing.history_invoices_body")}
        </p>
        {!hasBillingHistory ? (
          <div className="py-sp-8 text-center text-fg-subtle">
            <p className="m-0">{t("settings.billing.history_invoices_empty")}</p>
          </div>
        ) : invoicesLoading ? (
          <p className="mt-sp-5 text-[length:var(--text-body)] text-fg-muted" role="status">
            {t("settings.billing.invoices_loading")}
          </p>
        ) : invoicesError ? (
          <p
            className="mt-sp-5 rounded-md border border-[color:var(--danger-border)] bg-[color:var(--danger-subtle)] px-sp-5 py-sp-4 text-[length:var(--text-small)] text-fg"
            role="alert"
          >
            {invoicesError}
          </p>
        ) : invoices.length === 0 ? (
          <div className="py-sp-8 text-center text-fg-subtle">
            <p className="m-0">{t("settings.billing.history_invoices_none")}</p>
          </div>
        ) : (
          <div className="mt-sp-5 overflow-hidden rounded-lg border border-[color:var(--border-subtle)]">
            <div
              className="hidden grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto] gap-sp-4 border-b border-[color:var(--border-subtle)] px-sp-5 py-sp-3 text-[length:var(--text-small)] font-medium text-fg-muted md:grid"
              aria-hidden="true"
            >
              <span>{t("settings.billing.invoices_col_date")}</span>
              <span>{t("settings.billing.invoices_col_description")}</span>
              <span>{t("settings.billing.invoices_col_amount")}</span>
              <span>{t("settings.billing.invoices_col_status")}</span>
              <span className="sr-only">{t("settings.billing.invoices_col_download")}</span>
            </div>
            <ul className="m-0 list-none divide-y divide-[color:var(--border-subtle)] p-0">
              {invoices.map((invoice) => (
                <li
                  key={invoice.id}
                  className="grid grid-cols-1 gap-sp-2 px-sp-5 py-sp-4 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto] md:items-center md:gap-sp-4"
                  data-testid={`billing-invoice-row-${invoice.id}`}
                >
                  <span className="text-[length:var(--text-body)] text-fg">
                    <span className="mr-sp-2 text-fg-muted md:hidden">
                      {t("settings.billing.invoices_col_date")}:
                    </span>
                    {formatInvoiceDate(invoice.createdAt, locale)}
                  </span>
                  <span className="text-[length:var(--text-body)] text-fg">
                    <span className="mr-sp-2 text-fg-muted md:hidden">
                      {t("settings.billing.invoices_col_description")}:
                    </span>
                    {invoice.description || t("settings.billing.invoices_description_fallback")}
                  </span>
                  <span className="font-mono text-[length:var(--text-body)] text-fg">
                    <span className="mr-sp-2 font-sans text-fg-muted md:hidden">
                      {t("settings.billing.invoices_col_amount")}:
                    </span>
                    {formatInvoiceAmount(invoice.amount, invoice.currency, locale)}
                  </span>
                  <span>
                    <span className="mr-sp-2 text-fg-muted md:hidden">
                      {t("settings.billing.invoices_col_status")}:
                    </span>
                    <span className="inline-flex rounded-full bg-[color:var(--success-subtle)] px-sp-3 py-sp-1 text-[length:var(--text-small)] text-[color:var(--success-text)]">
                      {t(invoiceStatusKey(invoice.status))}
                    </span>
                  </span>
                  {invoice.invoicePdfUrl ? (
                    <a
                      className="inline-flex items-center justify-center rounded-md border border-[color:var(--border-subtle)] px-sp-4 py-sp-2 text-[length:var(--text-small)] text-fg-muted transition-colors duration-micro hover:bg-canvas hover:text-fg"
                      href={invoice.invoicePdfUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={t("settings.billing.invoices_download_aria")}
                    >
                      {t("settings.billing.invoices_download_action")}
                    </a>
                  ) : (
                    <span className="text-[length:var(--text-small)] text-fg-subtle">—</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <div className="flex flex-wrap items-center gap-sp-5 rounded-lg border border-[color:var(--border-subtle)] bg-raised p-sp-6">
        <div className="min-w-0 flex-1">
          <h3 className="m-0 text-[length:var(--text-body)] font-medium text-fg">
            {t("settings.billing.payment_method_heading")}
          </h3>
          <p className="mt-sp-2 text-[length:var(--text-small)] text-fg-subtle">
            {t("settings.billing.payment_method_body")}
          </p>
        </div>
        <Button
          variant="secondary"
          disabled={!canManage || busy || !workspace.billingCustomerId}
          onClick={onUpdatePaymentMethod}
          type="button"
        >
          {t("settings.billing.payment_method_action")}
        </Button>
      </div>
    </div>
  );
}
