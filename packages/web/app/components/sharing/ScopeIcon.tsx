import { useTranslation } from "react-i18next";

import type { SharingScope } from "./sharing.types.js";
import { getSharingScopeOption } from "./sharing-scope-option.js";

export type ScopeIconProps = {
  scope: SharingScope;
  className?: string;
};

export function ScopeIcon({ scope, className = "" }: ScopeIconProps) {
  const { t } = useTranslation();
  const option = getSharingScopeOption(scope);

  return (
    <span
      className={[
        "inline-grid h-[18px] w-[18px] place-items-center rounded-sm text-fg-subtle",
        className,
      ].join(" ")}
      title={t(option.labelKey)}
      aria-label={t(option.labelKey)}
      data-testid={`sharing-scope-icon-${scope}`}
    >
      {scope === "shared-with-me" ? "◎" : scope === "shared-by-me" ? "↗" : scope === "mine" ? "◉" : "▤"}
    </span>
  );
}
