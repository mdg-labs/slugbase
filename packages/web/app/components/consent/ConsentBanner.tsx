import { useTranslation } from "react-i18next";

import { Button } from "@slugbase/ui";

import { useAnalyticsConsent } from "./AnalyticsConsentProvider.js";

export function ConsentBanner() {
  const { t } = useTranslation();
  const { enabled, visible, accept, decline } = useAnalyticsConsent();

  if (!enabled || !visible) {
    return null;
  }

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-50 border-t border-[color:var(--border)] bg-overlay px-sp-6 py-sp-5 shadow-lg"
      role="dialog"
      aria-live="polite"
      aria-label={t("consent.banner.aria_label")}
    >
      <div className="mx-auto flex max-w-4xl flex-col gap-sp-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-fg" style={{ fontSize: "var(--text-body)" }}>
          {t("consent.banner.message")}
        </p>
        <div className="flex shrink-0 gap-sp-3">
          <Button variant="secondary" onClick={() => void decline()}>
            {t("consent.banner.decline")}
          </Button>
          <Button variant="primary" onClick={() => void accept()}>
            {t("consent.banner.accept")}
          </Button>
        </div>
      </div>
    </div>
  );
}
