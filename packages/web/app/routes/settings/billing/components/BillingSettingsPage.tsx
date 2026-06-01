import { useTranslate } from "@tolgee/react";
import { Button } from "@slugbase/ui";
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";

import { useAppToast } from "../../../../components/feedback/AppToastProvider.js";

import {
  openBillingPortal,
  startCheckout,
  updateSeatQuantity,
} from "../billing-api.js";
import {
  bookmarkMeterVariant,
  canAccessBillingSettings,
  canManageBilling,
  effectivePlanForDisplay,
  hasPaidAccess,
  isSubscriptionCancelled,
} from "../billing-entitlements.js";
import type { BillingPlanId, BillingSettingsData, BillingTabId } from "../billing.types.js";
import { BillingHistorySection } from "./BillingHistorySection.js";
import { BillingUnavailableGate } from "./BillingUnavailableGate.js";
import { CancelSubscriptionPanel } from "./CancelSubscriptionPanel.js";
import { PlanComparisonTable } from "./PlanComparisonTable.js";
import { SeatManagementSection } from "./SeatManagementSection.js";
import { SupporterOfferCard } from "./SupporterOfferCard.js";

function formatDate(value: string | null, locale: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

interface BillingSettingsPageProps {
  initialData: BillingSettingsData;
}

export function BillingSettingsPage({ initialData }: BillingSettingsPageProps) {
  const { t } = useTranslate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [workspace, setWorkspace] = useState(initialData.workspace);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { showToast } = useAppToast();

  const tab = (searchParams.get("tab") as BillingTabId | null) ?? "plan";
  const locale = "en";
  const canManage = canManageBilling(initialData.currentUserRole);
  const displayPlan = effectivePlanForDisplay(workspace);
  const cap = initialData.planConfig.freeBookmarkCap;
  const meterVariant = bookmarkMeterVariant(initialData.bookmarkCount, cap);
  const periodEndLabel = formatDate(workspace.billingPeriodEnd, locale);
  const cancelled = isSubscriptionCancelled(workspace);
  const paidAccess = hasPaidAccess(workspace);

  const showSupporter = displayPlan === "free" || initialData.archivedBookmarkCount > 0;

  const setTab = (next: BillingTabId) => {
    setSearchParams(next === "plan" ? {} : { tab: next });
  };

  const showError = (message: string) => {
    setErrorMessage(message);
  };

  const redirectExternal = (url: string) => {
    window.location.assign(url);
  };

  const handleCheckout = async (
    plan: Exclude<BillingPlanId, "free">,
    mode: "recurring" | "one_time" = "recurring",
  ) => {
    setBusy(true);
    try {
      const { checkoutUrl } = await startCheckout({
        workspaceId: workspace.id,
        plan,
        mode,
        successUrl: initialData.returnUrl,
        cancelUrl: initialData.returnUrl,
      });
      redirectExternal(checkoutUrl);
    } catch (err) {
      showError(err instanceof Error ? err.message : t("settings.billing.error_generic"));
    } finally {
      setBusy(false);
    }
  };

  const handlePlanSelect = async (plan: BillingPlanId) => {
    if (plan === "free") {
      if (workspace.billingCustomerId) {
        await handleOpenPortal();
      }
      return;
    }
    if (plan === "personal") {
      await handleCheckout("personal", "recurring");
      return;
    }
    await handleCheckout("team", "recurring");
  };

  const handleOpenPortal = async () => {
    setBusy(true);
    try {
      const { portalUrl } = await openBillingPortal(workspace.id, initialData.returnUrl);
      redirectExternal(portalUrl);
    } catch (err) {
      showError(err instanceof Error ? err.message : t("settings.billing.error_generic"));
    } finally {
      setBusy(false);
    }
  };

  const handleUpdateSeats = async (totalSeats: number) => {
    setBusy(true);
    try {
      const updated = await updateSeatQuantity(workspace.id, totalSeats);
      setWorkspace(updated);
      showToast("settings.billing.toast_seats_updated", { total: String(totalSeats) });
    } catch (err) {
      showError(err instanceof Error ? err.message : t("settings.billing.error_generic"));
    } finally {
      setBusy(false);
    }
  };

  const planSummary = useMemo(() => {
    if (workspace.permanentPersonal) {
      return {
        badgeKey: "settings.billing.plan_name_personal",
        titleKey: "settings.billing.plan_name_personal",
        priceKey: "settings.billing.current_permanent_price",
        priceParams: { price: initialData.planConfig.supporterPrice || "—" },
      };
    }
    if (displayPlan === "free") {
      return {
        badgeKey: "settings.billing.plan_name_free",
        titleKey: "settings.billing.plan_name_free",
        priceKey: "settings.billing.current_free_price",
        priceParams: {},
      };
    }
    if (displayPlan === "personal") {
      return {
        badgeKey: "settings.billing.plan_name_personal",
        titleKey: "settings.billing.plan_name_personal",
        priceKey: cancelled
          ? "settings.billing.current_cancelled_price"
          : "settings.billing.current_personal_price",
        priceParams: {
          price: initialData.planConfig.personalMonthlyPrice || "—",
          date: periodEndLabel ?? t("settings.billing.period_end_unknown"),
        },
      };
    }
    return {
      badgeKey: "settings.billing.plan_name_team",
      titleKey: "settings.billing.plan_name_team",
      priceKey: cancelled
        ? "settings.billing.current_cancelled_price"
        : "settings.billing.current_team_price",
      priceParams: {
        seats: String(workspace.planSeats ?? initialData.planConfig.teamBaseSeats),
        price: initialData.planConfig.teamSeatPrice || "—",
        date: periodEndLabel ?? t("settings.billing.period_end_unknown"),
      },
    };
  }, [
    workspace,
    displayPlan,
    cancelled,
    periodEndLabel,
    initialData.planConfig,
    t,
  ]);

  if (!canAccessBillingSettings(initialData.planConfig.billingEnabled)) {
    return <BillingUnavailableGate />;
  }

  return (
    <div className="mx-auto max-w-[680px] px-sp-6 py-sp-8" data-testid="billing-settings-page">
      <header className="mb-sp-8">
        <h1 className="m-0 text-[length:var(--text-body-lg)] font-semibold text-fg">
          {t("settings.billing.page_title")}
        </h1>
        <p className="mt-sp-3 text-[length:var(--text-body)] text-fg-muted">
          {t("settings.billing.page_subtitle", { workspace: workspace.name })}
        </p>
      </header>

      {!canManage ? (
        <p
          className="mb-sp-5 rounded-md border border-[color:var(--warning-border)] bg-[color:var(--warning-subtle)] px-sp-5 py-sp-4 text-[length:var(--text-small)] text-fg-muted"
          role="status"
        >
          {t("settings.billing.owner_only_notice")}
        </p>
      ) : null}

      {errorMessage ? (
        <p
          className="mb-sp-5 rounded-md border border-[color:var(--danger-border)] bg-[color:var(--danger-subtle)] px-sp-5 py-sp-4 text-[length:var(--text-small)] text-fg"
          role="alert"
        >
          {errorMessage}
        </p>
      ) : null}

      <div className="mb-sp-8 flex gap-sp-2 border-b border-[color:var(--border-subtle)]">
        {(["plan", "seats", "history"] as const).map((tabId) => (
          <button
            key={tabId}
            type="button"
            className={`border-b-2 px-sp-4 py-sp-3 text-[length:var(--text-body)] transition-colors duration-micro ${
              tab === tabId
                ? "border-accent text-fg"
                : "border-transparent text-fg-muted hover:text-fg"
            }`}
            onClick={() => {
              setTab(tabId);
            }}
          >
            {t(`settings.billing.tab_${tabId}`)}
          </button>
        ))}
      </div>

      {tab === "plan" ? (
        <div className="flex flex-col gap-sp-8">
          {initialData.archivedBookmarkCount > 0 ? (
            <div className="rounded-lg border border-[color:var(--warning-border)] bg-[color:var(--warning-subtle)] p-sp-6">
              <h2 className="m-0 text-[length:var(--text-body)] font-semibold text-fg">
                {t("settings.billing.archived_title", {
                  count: String(initialData.archivedBookmarkCount),
                })}
              </h2>
              <p className="mt-sp-3 text-[length:var(--text-body)] leading-relaxed text-fg-muted">
                {t("settings.billing.archived_body", { cap: String(cap) })}
              </p>
              <Button
                className="mt-sp-5"
                disabled={!canManage || busy}
                onClick={() => {
                  void handleCheckout("personal", "recurring");
                }}
                type="button"
              >
                {t("settings.billing.archived_upgrade_action", {
                  price: initialData.planConfig.personalMonthlyPrice || "—",
                })}
              </Button>
            </div>
          ) : null}

          <div
            className={`rounded-lg border bg-raised p-sp-6 ${
              meterVariant === "error"
                ? "border-[color:var(--danger-border)]"
                : meterVariant === "warn"
                  ? "border-[color:var(--warning-border)]"
                  : "border-[color:var(--border-subtle)]"
            }`}
          >
            <div className="flex flex-wrap items-start gap-sp-6">
              <div className="min-w-[220px] flex-1">
                <span className="inline-flex rounded-full bg-[color:var(--accent-subtle)] px-sp-3 py-sp-1 text-[length:var(--text-small)] font-medium text-accent-text">
                  {t(planSummary.badgeKey)}
                </span>
                <h2 className="mt-sp-3 m-0 text-[length:var(--text-body-lg)] font-semibold text-fg">
                  {t(planSummary.titleKey)}
                </h2>
                <p className="mt-sp-2 text-[length:var(--text-body)] text-fg-muted">
                  {t(planSummary.priceKey, planSummary.priceParams)}
                </p>
              </div>
              {displayPlan === "free" ? (
                <div className="min-w-[220px] flex-1">
                  <div className="mb-sp-2 flex justify-between text-[length:var(--text-small)] text-fg-muted">
                    <span>
                      {t("settings.billing.meter_usage", {
                        used: String(initialData.bookmarkCount),
                        cap: String(cap),
                      })}
                    </span>
                    <span>
                      {t("settings.billing.meter_remaining", {
                        count: String(Math.max(0, cap - initialData.bookmarkCount)),
                      })}
                    </span>
                  </div>
                  <div className="h-[5px] overflow-hidden rounded-full bg-canvas">
                    <div
                      className={`h-full rounded-full ${
                        meterVariant === "error"
                          ? "bg-danger"
                          : meterVariant === "warn"
                            ? "bg-warning"
                            : "bg-accent"
                      }`}
                      style={{
                        width: `${String(Math.min(100, Math.round((initialData.bookmarkCount / cap) * 100)))}%`,
                      }}
                    />
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          {cancelled && paidAccess ? (
            <div className="rounded-lg border border-[color:var(--border-subtle)] bg-raised p-sp-6">
              <p className="m-0 text-[length:var(--text-body)] leading-relaxed text-fg-muted">
                {t("settings.billing.cancelled_notice", {
                  date: periodEndLabel ?? t("settings.billing.period_end_unknown"),
                })}
              </p>
              <div className="mt-sp-5 flex flex-wrap gap-sp-4">
                <Button
                  disabled={!canManage || busy}
                  onClick={() => {
                    void handleOpenPortal();
                  }}
                  type="button"
                >
                  {t("settings.billing.reactivate_action")}
                </Button>
              </div>
            </div>
          ) : null}

          {displayPlan === "free" && meterVariant === "warn" ? (
            <p className="rounded-md border border-[color:var(--warning-border)] bg-[color:var(--warning-subtle)] px-sp-5 py-sp-4 text-[length:var(--text-body)] text-fg-muted">
              {t("settings.billing.approaching_cap_body", {
                used: String(initialData.bookmarkCount),
                cap: String(cap),
              })}
            </p>
          ) : null}

          {displayPlan === "free" && meterVariant === "error" ? (
            <p className="rounded-md border border-[color:var(--danger-border)] bg-[color:var(--danger-subtle)] px-sp-5 py-sp-4 text-[length:var(--text-body)] text-fg-muted">
              {t("settings.billing.at_cap_body", { cap: String(cap) })}
            </p>
          ) : null}

          {paidAccess && !workspace.permanentPersonal && !cancelled ? (
            <div className="flex flex-wrap gap-sp-4">
              {displayPlan === "personal" ? (
                <Button
                  variant="secondary"
                  disabled={!canManage || busy}
                  onClick={() => {
                    void handleCheckout("team", "recurring");
                  }}
                  type="button"
                >
                  {t("settings.billing.upgrade_team_action")}
                </Button>
              ) : null}
              {displayPlan === "team" ? (
                <Button
                  variant="ghost"
                  disabled={!canManage || busy}
                  onClick={() => {
                    void handleOpenPortal();
                  }}
                  type="button"
                >
                  {t("settings.billing.downgrade_personal_action")}
                </Button>
              ) : null}
              {workspace.billingCustomerId ? (
                <CancelSubscriptionPanel
                  periodEndLabel={periodEndLabel}
                  bookmarkCount={initialData.bookmarkCount}
                  freeCap={cap}
                  busy={busy}
                  onConfirmCancel={() => {
                    void handleOpenPortal();
                  }}
                  onKeep={() => {
                    showToast("settings.billing.toast_subscription_kept");
                  }}
                />
              ) : null}
            </div>
          ) : null}

          <section>
            <h2 className="mb-sp-2 text-[length:var(--text-body-lg)] font-semibold text-fg">
              {t("settings.billing.compare_heading")}
            </h2>
            <p className="mb-sp-5 text-[length:var(--text-body)] text-fg-muted">
              {t("settings.billing.compare_subtitle")}
            </p>
            <PlanComparisonTable
              currentPlan={displayPlan}
              config={initialData.planConfig}
              canManage={canManage}
              busy={busy}
              onSelectPlan={(plan) => {
                void handlePlanSelect(plan);
              }}
            />
          </section>

          {showSupporter ? (
            <section>
              <h2 className="mb-sp-2 text-[length:var(--text-body-lg)] font-semibold text-fg">
                {t("settings.billing.supporter_heading")}
              </h2>
              <p className="mb-sp-5 text-[length:var(--text-body)] text-fg-muted">
                {t("settings.billing.supporter_subtitle")}
              </p>
              <SupporterOfferCard
                config={initialData.planConfig}
                canManage={canManage}
                busy={busy}
                onClaim={() => {
                  void handleCheckout("personal", "one_time");
                }}
              />
            </section>
          ) : null}
        </div>
      ) : null}

      {tab === "seats" ? (
        <SeatManagementSection
          workspace={workspace}
          memberCount={initialData.memberCount}
          config={initialData.planConfig}
          canManage={canManage}
          busy={busy}
          onUpdateSeats={handleUpdateSeats}
          onUpgradeTeam={() => {
            void handleCheckout("team", "recurring");
          }}
        />
      ) : null}

      {tab === "history" ? (
        <BillingHistorySection
          workspace={workspace}
          canManage={canManage}
          busy={busy}
          onOpenPortal={() => {
            void handleOpenPortal();
          }}
        />
      ) : null}
    </div>
  );
}
