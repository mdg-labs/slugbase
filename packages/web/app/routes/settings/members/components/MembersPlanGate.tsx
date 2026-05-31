import { useTranslate } from "@tolgee/react";
import { Button } from "@slugbase/ui";

interface MembersPlanGateProps {
  onUpgrade?: () => void;
}

export function MembersPlanGate({ onUpgrade }: MembersPlanGateProps) {
  const { t } = useTranslate();

  return (
    <div
      className="mx-auto flex max-w-lg flex-col items-center gap-sp-6 px-sp-6 py-sp-12 text-center"
      data-testid="members-plan-gate"
    >
      <div className="rounded-lg border border-[color:var(--border-subtle)] bg-raised px-sp-8 py-sp-10">
        <h1 className="m-0 text-[length:var(--text-body-lg)] font-semibold text-fg">
          {t("settings.members.gate_title")}
        </h1>
        <p className="mt-sp-4 text-[length:var(--text-body)] text-fg-muted">
          {t("settings.members.gate_body")}
        </p>
        <Button className="mt-sp-6" onClick={onUpgrade} type="button">
          {t("settings.members.gate_upgrade_action")}
        </Button>
      </div>
    </div>
  );
}
