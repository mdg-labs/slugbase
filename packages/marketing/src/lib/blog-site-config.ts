import { t, type SupportedLocale } from "../i18n/translate.js";

export type BlogSiteConfig = {
  name: string;
  url: string;
  description: string;
};

/** RSS channel metadata from Astro `site` + marketing i18n (no hard-coded hostnames). */
export function getBlogSiteConfig(locale: SupportedLocale = "en"): BlogSiteConfig {
  const rawSite = import.meta.env.SITE;
  const url = (typeof rawSite === "string" ? rawSite : "").trim();
  if (!url) {
    throw new Error(
      "SITE is not configured; set PUBLIC_MARKETING_ORIGIN or MARKETING_ORIGIN for marketing builds",
    );
  }

  return {
    name: t(locale, "marketing.nav.brand"),
    url,
    description: t(locale, "marketing.meta.description"),
  };
}
