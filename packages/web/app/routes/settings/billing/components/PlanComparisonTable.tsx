import { useTranslation } from "react-i18next";
import { CheckIcon } from "lucide-react";
import { Button } from "@slugbase/ui";

import {
  buildPlanFeatureRows,
  formatPlanPriceLabel,
  resolvePlanCta,
  type PlanFeatureRow,
} from "../billing-plan-table.js";
import type { BillingPlanDisplayConfig, BillingPlanId } from "../billing.types.js";

interface PlanComparisonTableProps {
  currentPlan: BillingPlanId;
  config: BillingPlanDisplayConfig;
  canManage: boolean;
  busy: boolean;
  onSelectPlan: (plan: BillingPlanId) => void;
}

function FeatureCell({
  value,
  isCurrent,
  t,
}: {
  value: PlanFeatureRow["free"];
  isCurrent: boolean;
  t: (key: string) => string;
}) {
  if (value === "included") {
    return (
      <CheckIcon size={14} className="text-success-text" aria-label={t("settings.billing.feature_included_aria")} />
    );
  }
  if (value === "excluded") {
    return <span className="text-fg-faint">—</span>;
  }
  if (value.startsWith("settings.billing.")) {
    return (
      <span className="font-mono text-[length:var(--text-small)] text-fg-muted">{t(value)}</span>
    );
  }
  return (
    <span
      className={`font-mono text-[length:var(--text-small)] ${isCurrent ? "text-fg" : "text-fg-muted"}`}
    >
      {value}
    </span>
  );
}

const PLAN_IDS: BillingPlanId[] = ["free", "personal", "team"];

export function PlanComparisonTable({
  currentPlan,
  config,
  canManage,
  busy,
  onSelectPlan,
}: PlanComparisonTableProps) {
  const { t } = useTranslation();
  const features = buildPlanFeatureRows(config);

  return (
    <div
      className="overflow-hidden rounded-lg border border-[color:var(--border-subtle)] bg-raised"
      data-testid="billing-plan-table"
    >
      <div className="grid grid-cols-4 border-b border-[color:var(--border-subtle)] bg-base">
        <div className="px-sp-5 py-sp-4 text-[length:var(--text-small)] font-medium text-fg-subtle">
          {t("settings.billing.compare_features_heading")}
        </div>
        {PLAN_IDS.map((planId) => {
          const { price, periodKey } = formatPlanPriceLabel(planId, config);
          const isCurrent = planId === currentPlan;
          return (
            <div
              key={planId}
              className={`px-sp-5 py-sp-4 ${isCurrent ? "bg-[color:var(--accent-subtle)]" : ""}`}
            >
              <div
                className={`mb-sp-2 inline-flex rounded-full px-sp-3 py-sp-1 text-[length:var(--text-small)] font-medium ${
                  isCurrent
                    ? "bg-accent text-accent-fg"
                    : "bg-raised-2 text-fg-muted"
                }`}
              >
                {t(`settings.billing.plan_name_${planId}`)}
              </div>
              <div className="font-mono text-[length:var(--text-body)] text-fg">
                {price}
                <span className="text-[length:var(--text-small)] text-fg-subtle">
                  {" "}
                  {t(periodKey)}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {features.map((feature) => (
        <div
          key={feature.key}
          className="grid grid-cols-4 border-b border-[color:var(--border-subtle)] last:border-b-0"
        >
          <div className="px-sp-5 py-sp-4 text-[length:var(--text-body)] text-fg-muted">
            {t(feature.key)}
          </div>
          {PLAN_IDS.map((planId) => {
            const value = feature[planId];
            const isCurrent = planId === currentPlan;
            return (
              <div
                key={`${feature.key}-${planId}`}
                className={`px-sp-5 py-sp-4 ${isCurrent ? "bg-[color:var(--accent-subtle)]/40" : ""}`}
              >
                <FeatureCell value={value} isCurrent={isCurrent} t={t} />
              </div>
            );
          })}
        </div>
      ))}

      <div className="grid grid-cols-4 border-t border-[color:var(--border-subtle)]">
        <div className="px-sp-5 py-sp-4" />
        {PLAN_IDS.map((planId) => {
          const cta = resolvePlanCta(currentPlan, planId);
          const isCurrent = cta === "current";
          return (
            <div
              key={`cta-${planId}`}
              className={`flex items-center px-sp-5 py-sp-4 ${planId === currentPlan ? "bg-[color:var(--accent-subtle)]/40" : ""}`}
            >
              {isCurrent ? (
                <span className="text-[length:var(--text-small)] font-medium text-accent-text">
                  {t("settings.billing.plan_current_label")}
                </span>
              ) : (
                <Button
                  variant={cta === "upgrade" && planId === "team" ? "primary" : "secondary"}
                  disabled={!canManage || busy}
                  onClick={() => {
                    onSelectPlan(planId);
                  }}
                  type="button"
                >
                  {cta === "upgrade"
                    ? t("settings.billing.plan_upgrade_action", {
                        plan: t(`settings.billing.plan_name_${planId}`),
                      })
                    : t("settings.billing.plan_downgrade_action", {
                        plan: t(`settings.billing.plan_name_${planId}`),
                      })}
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
