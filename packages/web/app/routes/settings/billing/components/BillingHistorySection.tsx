import { useTranslate } from "@tolgee/react";
import { Button } from "@slugbase/ui";

import { hasPaidAccess } from "../billing-entitlements.js";
import type { BillingWorkspaceSummary } from "../billing.types.js";

interface BillingHistorySectionProps {
  workspace: BillingWorkspaceSummary;
  canManage: boolean;
  busy: boolean;
  onOpenPortal: () => void;
}

export function BillingHistorySection({
  workspace,
  canManage,
  busy,
  onOpenPortal,
}: BillingHistorySectionProps) {
  const { t } = useTranslate();
  const hasBillingHistory = hasPaidAccess(workspace) && Boolean(workspace.billingCustomerId);

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
            {t("settings.billing.history_payment_managed")}
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
        {hasBillingHistory ? (
          <p className="mt-sp-5 text-[length:var(--text-body)] text-fg-muted">
            {t("settings.billing.history_invoices_portal_hint")}
          </p>
        ) : (
          <div className="py-sp-8 text-center text-fg-subtle">
            <p className="m-0">{t("settings.billing.history_invoices_empty")}</p>
          </div>
        )}
      </section>

      <div className="flex flex-wrap items-center gap-sp-5 rounded-lg border border-[color:var(--border-subtle)] bg-raised p-sp-6">
        <div className="min-w-0 flex-1">
          <h3 className="m-0 text-[length:var(--text-body)] font-medium text-fg">
            {t("settings.billing.portal_heading")}
          </h3>
          <p className="mt-sp-2 text-[length:var(--text-small)] text-fg-subtle">
            {t("settings.billing.portal_body")}
          </p>
        </div>
        <Button
          variant="secondary"
          disabled={!canManage || busy || !workspace.billingCustomerId}
          onClick={onOpenPortal}
          type="button"
        >
          {t("settings.billing.portal_open_action")}
        </Button>
      </div>
    </div>
  );
}
