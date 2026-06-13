import { useTranslation } from "react-i18next";
import { Button, Input, Label } from "@slugbase/ui";

import { teamCheckoutMinSeats, TEAM_MIN_SEATS } from "../billing-entitlements.js";
import { formatPlanPriceLabel, formatSeatTotalPrice } from "../billing-plan-table.js";
import type { BillingInterval, BillingPlanDisplayConfig } from "../billing.types.js";

interface TeamCheckoutSeatPickerProps {
  memberCount: number;
  config: BillingPlanDisplayConfig;
  interval: BillingInterval;
  seatQuantity: number;
  canManage: boolean;
  busy: boolean;
  onSeatQuantityChange: (value: number) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export function TeamCheckoutSeatPicker({
  memberCount,
  config,
  interval,
  seatQuantity,
  canManage,
  busy,
  onSeatQuantityChange,
  onConfirm,
  onCancel,
}: TeamCheckoutSeatPickerProps) {
  const { t } = useTranslation();
  const minSeats = teamCheckoutMinSeats(memberCount);
  const { price: seatPrice, periodKey } = formatPlanPriceLabel("team", config, interval);
  const totalPrice = formatSeatTotalPrice(seatPrice, seatQuantity);
  const belowMin = seatQuantity < minSeats;

  return (
    <div
      className="rounded-lg border border-[color:var(--accent-border)] bg-[color:var(--accent-subtle)]/30 p-sp-6"
      data-testid="billing-team-checkout-picker"
    >
      <h3 className="m-0 text-[length:var(--text-body)] font-semibold text-fg">
        {t("settings.billing.checkout_team_heading")}
      </h3>
      <p className="mt-sp-3 text-[length:var(--text-body)] leading-relaxed text-fg-muted">
        {t("settings.billing.checkout_team_body", { min: String(minSeats) })}
      </p>

      <div className="mt-sp-6 flex flex-wrap items-end gap-sp-6">
        <div>
          <Label htmlFor="billing-team-checkout-seats">
            {t("settings.billing.checkout_team_seats_label")}
          </Label>
          <div className="mt-sp-2 flex items-center gap-sp-3">
            <Button
              variant="secondary"
              disabled={seatQuantity <= minSeats || busy}
              onClick={() => {
                onSeatQuantityChange(Math.max(minSeats, seatQuantity - 1));
              }}
              type="button"
              aria-label={t("settings.billing.checkout_team_decrease_aria")}
            >
              −
            </Button>
            <Input
              id="billing-team-checkout-seats"
              className="w-20 text-center font-mono"
              min={minSeats}
              type="number"
              value={seatQuantity}
              onChange={(event) => {
                const parsed = Number.parseInt(event.target.value, 10);
                onSeatQuantityChange(Number.isFinite(parsed) ? parsed : minSeats);
              }}
              disabled={busy}
              data-testid="billing-team-checkout-seats-input"
            />
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                onSeatQuantityChange(seatQuantity + 1);
              }}
              type="button"
              aria-label={t("settings.billing.checkout_team_increase_aria")}
            >
              +
            </Button>
          </div>
          {belowMin ? (
            <p
              className="mt-sp-2 text-[length:var(--text-small)] text-danger-text"
              role="alert"
              data-testid="billing-team-checkout-min-error"
            >
              {memberCount > TEAM_MIN_SEATS
                ? t("settings.billing.checkout_team_below_members_error", {
                    members: String(memberCount),
                  })
                : t("settings.billing.checkout_team_min_seats_error", {
                    min: String(minSeats),
                  })}
            </p>
          ) : null}
        </div>

        <div className="min-w-[200px]">
          <p className="m-0 text-[length:var(--text-small)] text-fg-muted">
            {t("settings.billing.checkout_team_price_preview", {
              seats: String(seatQuantity),
              seatPrice,
              total: totalPrice,
              period: t(periodKey),
            })}
          </p>
        </div>
      </div>

      <div className="mt-sp-6 flex flex-wrap gap-sp-4">
        <Button
          disabled={!canManage || busy || belowMin}
          onClick={onConfirm}
          type="button"
          data-testid="billing-team-checkout-confirm"
        >
          {t("settings.billing.checkout_team_confirm")}
        </Button>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={onCancel}
          type="button"
        >
          {t("settings.billing.checkout_team_cancel")}
        </Button>
      </div>
    </div>
  );
}
