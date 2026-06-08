import { useTranslation } from "react-i18next";
import { Button } from "@slugbase/ui";

import type { EntitlementBannerState } from "./dashboard.types.js";

export type DashboardEntitlementBannerProps = {
  banner: EntitlementBannerState;
};

export function DashboardEntitlementBanner({
  banner,
}: DashboardEntitlementBannerProps) {
  const { t } = useTranslation();
  const atCap = banner.variant === "at-cap";

  return (
    <div
      className={[
        "mb-sp-7 flex items-center gap-sp-5 rounded-lg border px-sp-6 py-sp-5",
        atCap
          ? "border-[color:rgba(240,104,107,0.32)] bg-[linear-gradient(100deg,var(--danger-subtle),transparent_70%)]"
          : "border-[color:var(--accent-border)] bg-[linear-gradient(100deg,var(--accent-subtle),transparent_70%)]",
      ].join(" ")}
      data-testid="dashboard-entitlement-banner"
      data-variant={banner.variant}
    >
      <span
        className={[
          "grid h-9 w-9 shrink-0 place-items-center rounded-md",
          atCap
            ? "bg-danger text-[color:var(--danger-fg)]"
            : "bg-accent text-accent-fg",
        ].join(" ")}
        aria-hidden
      >
        {atCap ? "!" : "↑"}
      </span>
      <div className="min-w-0 flex-1">
        <p
          className="font-semibold text-fg"
          style={{ fontSize: "var(--text-body-lg)" }}
        >
          {atCap
            ? t("dashboard.entitlement.at_cap_title")
            : t("dashboard.entitlement.approaching_title", {
                count: banner.remaining,
              })}
        </p>
        <p className="mt-sp-2 text-small text-fg-muted">
          {atCap
            ? t("dashboard.entitlement.at_cap_body", { cap: banner.cap })
            : t("dashboard.entitlement.approaching_body", {
                cap: banner.cap,
                used: banner.used,
              })}
        </p>
      </div>
      <Button variant="primary" className="shrink-0 text-small">
        {t("dashboard.entitlement.upgrade_action")}
      </Button>
    </div>
  );
}
