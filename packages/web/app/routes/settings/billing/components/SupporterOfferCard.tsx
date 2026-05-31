import { useTranslate } from "@tolgee/react";
import { Button } from "@slugbase/ui";
import { useEffect, useState } from "react";

import { isSupporterPromotionActive } from "../billing-config.js";
import type { BillingPlanDisplayConfig } from "../billing.types.js";

interface SupporterOfferCardProps {
  config: BillingPlanDisplayConfig;
  canManage: boolean;
  busy: boolean;
  onClaim: () => void;
}

function useCountdown(targetMs: number | null) {
  const [diff, setDiff] = useState(() =>
    targetMs ? Math.max(0, targetMs - Date.now()) : 0,
  );

  useEffect(() => {
    if (!targetMs) return undefined;
    const timer = setInterval(() => {
      setDiff(Math.max(0, targetMs - Date.now()));
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [targetMs]);

  const days = Math.floor(diff / 86_400_000);
  const hours = Math.floor((diff % 86_400_000) / 3_600_000);
  const minutes = Math.floor((diff % 3_600_000) / 60_000);
  const seconds = Math.floor((diff % 60_000) / 1000);

  return { days, hours, minutes, seconds, active: targetMs !== null && diff > 0 };
}

export function SupporterOfferCard({
  config,
  canManage,
  busy,
  onClaim,
}: SupporterOfferCardProps) {
  const { t } = useTranslate();
  const endMs = config.supporterPromotionEnd
    ? new Date(config.supporterPromotionEnd).getTime()
    : null;
  const countdown = useCountdown(Number.isNaN(endMs) ? null : endMs);

  if (!isSupporterPromotionActive(config)) {
    return null;
  }

  return (
    <section
      className="rounded-lg border border-[color:var(--accent-border)] bg-[color:var(--accent-subtle)] p-sp-6"
      data-testid="billing-supporter-offer"
    >
      <p className="m-0 text-[length:var(--text-small)] font-medium uppercase tracking-wide text-accent-text">
        {t("settings.billing.supporter_eyebrow")}
      </p>
      <div className="mt-sp-5 flex flex-wrap items-start gap-sp-7">
        <div className="min-w-[240px] flex-1">
          <p className="m-0 font-mono text-[length:var(--text-body-lg)] font-semibold text-fg">
            {config.supporterPrice || "—"}{" "}
            <span className="text-[length:var(--text-small)] font-normal text-fg-muted">
              {t("settings.billing.supporter_price_subtitle")}
            </span>
          </p>
          <p className="mt-sp-4 text-[length:var(--text-body)] leading-relaxed text-fg-muted">
            {t("settings.billing.supporter_body")}
          </p>
          <Button
            className="mt-sp-5"
            disabled={!canManage || busy || !config.supporterPrice}
            onClick={onClaim}
            type="button"
          >
            {t("settings.billing.supporter_claim_action", {
              price: config.supporterPrice || "—",
            })}
          </Button>
        </div>
        {endMs && countdown.active ? (
          <div className="flex flex-col gap-sp-3">
            <span className="text-[length:var(--text-small)] font-medium text-fg-subtle">
              {t("settings.billing.supporter_countdown_label")}
            </span>
            <div className="flex items-center gap-sp-2 font-mono text-[length:var(--text-body-lg)] text-fg">
              {[
                [countdown.days, t("settings.billing.supporter_countdown_days")],
                [countdown.hours, t("settings.billing.supporter_countdown_hours")],
                [countdown.minutes, t("settings.billing.supporter_countdown_minutes")],
                [countdown.seconds, t("settings.billing.supporter_countdown_seconds")],
              ].map(([value, label], index, items) => (
                <span key={label} className="flex items-center gap-sp-2">
                  <span className="rounded-md bg-base px-sp-3 py-sp-2">
                    {String(value).padStart(2, "0")}
                    <span className="ml-sp-1 text-[length:var(--text-micro)] text-fg-subtle">
                      {label}
                    </span>
                  </span>
                  {index < items.length - 1 ? (
                    <span className="text-fg-faint">:</span>
                  ) : null}
                </span>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
