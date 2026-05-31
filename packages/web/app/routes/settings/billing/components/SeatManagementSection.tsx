import { useTranslate } from "@tolgee/react";
import { Button, Input, Label } from "@slugbase/ui";
import { useState } from "react";

import { seatBreakdown } from "../billing-entitlements.js";
import type { BillingPlanDisplayConfig, BillingWorkspaceSummary } from "../billing.types.js";

interface SeatManagementSectionProps {
  workspace: BillingWorkspaceSummary;
  memberCount: number;
  config: BillingPlanDisplayConfig;
  canManage: boolean;
  busy: boolean;
  onUpdateSeats: (totalSeats: number) => Promise<void>;
  onUpgradeTeam: () => void;
}

export function SeatManagementSection({
  workspace,
  memberCount,
  config,
  canManage,
  busy,
  onUpdateSeats,
  onUpgradeTeam,
}: SeatManagementSectionProps) {
  const { t } = useTranslate();
  const breakdown = seatBreakdown(workspace.planSeats, config.teamBaseSeats, memberCount);
  const [adding, setAdding] = useState(0);
  const [draftTotal, setDraftTotal] = useState(breakdown.total);

  if (workspace.plan !== "team") {
    return (
      <div
        className="rounded-lg border border-[color:var(--border-subtle)] bg-raised p-sp-6"
        data-testid="billing-seats-gate"
      >
        <p className="m-0 text-[length:var(--text-body)] text-fg-muted">
          {t("settings.billing.seats_team_only_body")}
        </p>
        <Button className="mt-sp-5" disabled={!canManage || busy} onClick={onUpgradeTeam} type="button">
          {t("settings.billing.seats_upgrade_team_action")}
        </Button>
      </div>
    );
  }

  const nextTotal = breakdown.total + adding;
  const canRemove = draftTotal > breakdown.minTotal;

  return (
    <div className="flex flex-col gap-sp-8" data-testid="billing-seats-section">
      <div className="grid gap-sp-4 sm:grid-cols-2 lg:grid-cols-4">
        {(
          [
            { value: breakdown.included, labelKey: "settings.billing.seats_included_label" },
            { value: breakdown.extra, labelKey: "settings.billing.seats_extra_label" },
            { value: breakdown.total, labelKey: "settings.billing.seats_total_label" },
            { value: breakdown.inUse, labelKey: "settings.billing.seats_in_use_label" },
          ] as const
        ).map(({ value, labelKey }) => (
          <div
            key={labelKey}
            className="rounded-lg border border-[color:var(--border-subtle)] bg-raised px-sp-5 py-sp-5"
          >
            <div className="font-mono text-[length:var(--text-body-lg)] font-semibold text-fg">
              {value}
            </div>
            <div className="mt-sp-2 text-[length:var(--text-small)] text-fg-muted">
              {t(labelKey)}
            </div>
          </div>
        ))}
      </div>

      <section className="rounded-lg border border-[color:var(--border-subtle)] bg-raised p-sp-6">
        <h3 className="m-0 text-[length:var(--text-body)] font-semibold text-fg">
          {t("settings.billing.seats_add_heading")}
        </h3>
        <p className="mt-sp-2 text-[length:var(--text-small)] text-fg-muted">
          {t("settings.billing.seats_add_body", {
            price: config.teamSeatPrice || "—",
          })}
        </p>
        <div className="mt-sp-5 flex flex-wrap items-end gap-sp-4">
          <div>
            <Label htmlFor="billing-seats-add">{t("settings.billing.seats_add_label")}</Label>
            <div className="mt-sp-2 flex items-center gap-sp-3">
              <Button
                variant="secondary"
                disabled={adding <= 0 || busy}
                onClick={() => {
                  setAdding((value) => Math.max(0, value - 1));
                }}
                type="button"
              >
                −
              </Button>
              <Input
                id="billing-seats-add"
                className="w-20 text-center font-mono"
                min={0}
                type="number"
                value={adding}
                onChange={(event) => {
                  setAdding(Math.max(0, Number(event.target.value) || 0));
                }}
                disabled={busy}
              />
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  setAdding((value) => value + 1);
                }}
                type="button"
              >
                +
              </Button>
            </div>
          </div>
          <p className="text-[length:var(--text-body)] text-fg-muted">
            {adding > 0
              ? t("settings.billing.seats_add_preview", { total: String(nextTotal) })
              : t("settings.billing.seats_add_no_change")}
          </p>
          <Button
            disabled={!canManage || busy || adding === 0}
            onClick={() => {
              void onUpdateSeats(nextTotal).then(() => {
                setAdding(0);
              });
            }}
            type="button"
          >
            {t("settings.billing.seats_add_confirm")}
          </Button>
        </div>
      </section>

      <section className="rounded-lg border border-[color:var(--border-subtle)] bg-raised p-sp-6">
        <h3 className="m-0 text-[length:var(--text-body)] font-semibold text-fg">
          {t("settings.billing.seats_remove_heading")}
        </h3>
        <p className="mt-sp-2 text-[length:var(--text-small)] text-fg-muted">
          {t("settings.billing.seats_remove_body", {
            members: String(breakdown.minTotal),
          })}
        </p>
        <div className="mt-sp-5 flex flex-wrap items-end gap-sp-4">
          <div className="flex items-center gap-sp-3">
            <Button
              variant="secondary"
              disabled={!canRemove || busy}
              onClick={() => {
                setDraftTotal((value) => Math.max(breakdown.minTotal, value - 1));
              }}
              type="button"
            >
              −
            </Button>
            <Input
              className="w-20 text-center font-mono"
              readOnly
              value={draftTotal}
            />
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setDraftTotal((value) => value + 1);
              }}
              type="button"
            >
              +
            </Button>
          </div>
          {!canRemove ? (
            <p className="text-[length:var(--text-small)] text-fg-muted">
              {t("settings.billing.seats_remove_floor", {
                members: String(breakdown.minTotal),
              })}
            </p>
          ) : null}
          <Button
            disabled={!canManage || busy || draftTotal === breakdown.total || !canRemove}
            onClick={() => {
              void onUpdateSeats(draftTotal);
            }}
            type="button"
          >
            {t("settings.billing.seats_remove_confirm")}
          </Button>
        </div>
      </section>
    </div>
  );
}
