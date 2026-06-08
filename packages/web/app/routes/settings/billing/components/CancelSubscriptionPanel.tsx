import { useTranslation } from "react-i18next";
import { Button } from "@slugbase/ui";
import { useState } from "react";

interface CancelSubscriptionPanelProps {
  periodEndLabel: string | null;
  bookmarkCount: number;
  freeCap: number;
  busy: boolean;
  onConfirmCancel: () => void;
  onKeep: () => void;
}

export function CancelSubscriptionPanel({
  periodEndLabel,
  bookmarkCount,
  freeCap,
  busy,
  onConfirmCancel,
  onKeep,
}: CancelSubscriptionPanelProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const overflow = Math.max(0, bookmarkCount - freeCap);

  if (!open) {
    return (
      <Button
        variant="ghost"
        className="text-danger-text"
        disabled={busy}
        onClick={() => {
          setOpen(true);
        }}
        type="button"
      >
        {t("settings.billing.cancel_open_action")}
      </Button>
    );
  }

  return (
    <div
      className="rounded-lg border border-[color:var(--border-subtle)] bg-raised p-sp-6"
      data-testid="billing-cancel-panel"
    >
      <h3 className="m-0 text-[length:var(--text-body)] font-semibold text-fg">
        {t("settings.billing.cancel_title")}
      </h3>
      <p className="mt-sp-4 text-[length:var(--text-body)] leading-relaxed text-fg-muted">
        {t("settings.billing.cancel_body", {
          date: periodEndLabel ?? t("settings.billing.period_end_unknown"),
        })}
      </p>
      {overflow > 0 ? (
        <p className="mt-sp-3 text-[length:var(--text-small)] text-fg-muted">
          {t("settings.billing.cancel_overflow_note", {
            count: String(overflow),
            cap: String(freeCap),
          })}
        </p>
      ) : null}
      <div className="mt-sp-5 flex flex-wrap gap-sp-4">
        {!confirmed ? (
          <>
            <Button
              variant="primary"
              className="bg-danger text-[color:var(--danger-fg)]"
              disabled={busy}
              onClick={() => {
                setConfirmed(true);
              }}
              type="button"
            >
              {t("settings.billing.cancel_confirm_step_one")}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setOpen(false);
                onKeep();
              }}
              type="button"
            >
              {t("settings.billing.cancel_keep_action")}
            </Button>
          </>
        ) : (
          <>
            <Button disabled={busy} onClick={onConfirmCancel} type="button">
              {t("settings.billing.cancel_confirm_final")}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setConfirmed(false);
              }}
              type="button"
            >
              {t("settings.billing.cancel_back_action")}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
