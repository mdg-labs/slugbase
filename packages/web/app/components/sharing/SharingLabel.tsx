import { useTranslate } from "@tolgee/react";

import type { SharingScope } from "./sharing.types.js";

export type SharingLabelProps = {
  scope: SharingScope;
  shareGrantCount?: number;
};

export function SharingLabel({ scope, shareGrantCount = 0 }: SharingLabelProps) {
  const { t } = useTranslate();

  if (scope === "shared-with-me") {
    return (
      <span
        className="inline-flex items-center gap-sp-2 rounded-sm bg-[color:var(--warning-subtle)] px-sp-3 py-sp-1 text-small text-[color:var(--warning-text)]"
        data-testid="sharing-label-shared-with-you"
      >
        {t("sharing.label.shared_with_you")}
      </span>
    );
  }

  if (scope === "shared-by-me" && shareGrantCount > 0) {
    return (
      <span
        className="inline-flex items-center gap-sp-2 rounded-sm bg-[color:var(--accent-subtle)] px-sp-3 py-sp-1 text-small text-accent-text"
        data-testid="sharing-label-shared-by-you"
      >
        {t("sharing.label.shared_with_count", { count: shareGrantCount })}
      </span>
    );
  }

  return null;
}
