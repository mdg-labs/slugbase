import { useTranslate } from "@tolgee/react";
import { Button } from "@slugbase/ui";
import { useNavigate } from "react-router";

export function AuditPlanGate() {
  const { t } = useTranslate();
  const navigate = useNavigate();

  return (
    <div
      className="mx-auto flex max-w-lg flex-col items-center gap-sp-6 px-sp-6 py-sp-12 text-center"
      data-testid="audit-plan-gate"
    >
      <div className="rounded-lg border border-[color:var(--border-subtle)] bg-raised px-sp-8 py-sp-10">
        <div
          className="mx-auto mb-sp-5 flex h-12 w-12 items-center justify-center rounded-full border border-[color:var(--border-subtle)] bg-raised-2"
          aria-hidden
        >
          <svg
            className="h-[22px] w-[22px] text-fg-subtle"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            viewBox="0 0 24 24"
          >
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
        </div>
        <h2 className="m-0 text-[length:var(--text-body-lg)] font-semibold text-fg">
          {t("settings.audit.gate_title")}
        </h2>
        <p className="mt-sp-4 text-[length:var(--text-body)] text-fg-muted">
          {t("settings.audit.gate_body")}
        </p>
        <Button
          className="mt-sp-6"
          onClick={() => { void navigate("/settings/billing"); }}
          type="button"
        >
          {t("settings.audit.gate_upgrade_action")}
        </Button>
      </div>
    </div>
  );
}
