import { useTranslation } from "react-i18next";

import type { BillingInterval } from "../billing.types.js";

interface BillingIntervalToggleProps {
  value: BillingInterval;
  onChange: (interval: BillingInterval) => void;
}

export function BillingIntervalToggle({
  value,
  onChange,
}: BillingIntervalToggleProps) {
  const { t } = useTranslation();

  const options: { value: BillingInterval; labelKey: string }[] = [
    { value: "monthly", labelKey: "settings.billing.interval_monthly" },
    { value: "annual", labelKey: "settings.billing.interval_annual" },
  ];

  return (
    <div
      className="flex items-center gap-sp-3"
      role="radiogroup"
      aria-label={t("settings.billing.interval_toggle_label")}
    >
      {options.map((option) => {
        const isActive = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={isActive}
            data-testid={`billing-interval-${option.value}`}
            className={`rounded-full px-sp-4 py-sp-2 text-[length:var(--text-small)] font-medium transition-colors duration-micro ${
              isActive
                ? "bg-accent text-accent-fg"
                : "bg-raised-2 text-fg-muted hover:text-fg"
            }`}
            onClick={() => {
              onChange(option.value);
            }}
          >
            {t(option.labelKey)}
          </button>
        );
      })}
    </div>
  );
}
