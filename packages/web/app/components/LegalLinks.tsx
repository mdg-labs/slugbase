import { useTranslation } from "react-i18next";

import { useAppLocale } from "../i18n/use-app-locale.js";
import {
  buildMarketingLegalUrl,
  type MarketingLegalPage,
} from "../lib/marketing-origin.js";

const LEGAL_PAGES: readonly { page: MarketingLegalPage; labelKey: string }[] = [
  { page: "impressum", labelKey: "app.legal.impressum" },
  { page: "datenschutz", labelKey: "app.legal.privacy" },
  { page: "agb", labelKey: "app.legal.terms" },
] as const;

export type LegalLinksProps = {
  /** Sidebar footer vs auth form pane (prototype auth.css `.foot.spread`). */
  variant?: "sidebar" | "auth";
};

export function LegalLinks({ variant = "sidebar" }: LegalLinksProps) {
  const { t } = useTranslation();
  const locale = useAppLocale();

  const links = LEGAL_PAGES.map(({ page, labelKey }) => ({
    page,
    label: t(labelKey),
    href: buildMarketingLegalUrl(locale, page),
  })).filter((link): link is typeof link & { href: string } => link.href !== null);

  if (links.length === 0) {
    return null;
  }

  const isAuth = variant === "auth";

  return (
    <nav
      aria-label={t("app.legal.nav_aria_label")}
      data-testid="legal-links"
      className={
        isAuth
          ? "mt-sp-8 flex flex-wrap items-center justify-center gap-x-sp-4 gap-y-sp-2 text-[length:var(--text-body)] text-fg-muted"
          : "flex flex-wrap items-center gap-x-sp-3 gap-y-sp-2 px-sp-4 text-[length:var(--text-micro)] text-fg-subtle"
      }
    >
      {links.map((link, index) => (
        <span key={link.page} className="inline-flex items-center gap-sp-3">
          {index > 0 && (
            <span className="text-fg-faint" aria-hidden="true">
              ·
            </span>
          )}
          <a
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
            data-testid={`legal-link-${link.page}`}
            className={
              isAuth
                ? "font-medium text-accent-text no-underline hover:underline"
                : "text-fg-muted no-underline hover:text-fg hover:underline"
            }
          >
            {link.label}
          </a>
        </span>
      ))}
    </nav>
  );
}
