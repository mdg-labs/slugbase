import { useTranslation } from "react-i18next";

interface BillingUnavailableGateProps {
  onBack?: () => void;
}

export function BillingUnavailableGate({ onBack }: BillingUnavailableGateProps) {
  const { t } = useTranslation();

  return (
    <div
      className="mx-auto flex max-w-lg flex-col items-center gap-sp-6 px-sp-6 py-sp-12 text-center"
      data-testid="billing-unavailable-gate"
    >
      <div className="rounded-lg border border-[color:var(--border-subtle)] bg-raised px-sp-8 py-sp-10">
        <h1 className="m-0 text-[length:var(--text-body-lg)] font-semibold text-fg">
          {t("settings.billing.unavailable_title")}
        </h1>
        <p className="mt-sp-4 text-[length:var(--text-body)] text-fg-muted">
          {t("settings.billing.unavailable_body")}
        </p>
        {onBack ? (
          <button
            className="mt-sp-6 text-[length:var(--text-body)] text-accent-text"
            onClick={onBack}
            type="button"
          >
            {t("settings.billing.unavailable_back_action")}
          </button>
        ) : null}
      </div>
    </div>
  );
}
