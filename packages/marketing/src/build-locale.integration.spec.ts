import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { t } from "./i18n/translate.js";
import {
  formatMarketingBrandTitle,
  formatMarketingPageTitle,
} from "./i18n/format-marketing-page-title.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("marketing build output", () => {
  it("builds and renders landing for en and de", () => {
    execSync("pnpm build", {
      cwd: packageRoot,
      stdio: "pipe",
      env: {
        ...process.env,
        PUBLIC_API_BASE_URL: "https://api.slugbase.test",
        PUBLIC_CONTACT_ENDPOINT: "https://api.slugbase.test/contact",
      },
    });

    const enHtml = readFileSync(join(packageRoot, "dist/index.html"), "utf8");
    const deHtml = readFileSync(join(packageRoot, "dist/de/index.html"), "utf8");
    const enPricing = readFileSync(join(packageRoot, "dist/pricing/index.html"), "utf8");
    const dePricing = readFileSync(join(packageRoot, "dist/de/pricing/index.html"), "utf8");
    const enPrivacy = readFileSync(join(packageRoot, "dist/legal/datenschutz/index.html"), "utf8");
    const enContact = readFileSync(join(packageRoot, "dist/contact/index.html"), "utf8");
    const deContact = readFileSync(join(packageRoot, "dist/de/contact/index.html"), "utf8");

    expect(enHtml).toContain(t("en", "marketing.landing.hero_title"));
    expect(enHtml).toContain(t("en", "marketing.landing.hero_title_accent"));
    expect(enHtml).toContain('data-pricing-teaser="personal-monthly"');
    expect(deHtml).toContain(t("de", "marketing.landing.hero_title"));
    expect(deHtml).toContain(t("de", "marketing.landing.hero_title_accent"));
    expect(enHtml).toContain('lang="en"');
    expect(deHtml).toContain('lang="de"');
    expect(enHtml).toContain(`<title>${formatMarketingBrandTitle("en")}</title>`);
    expect(deHtml).toContain(`<title>${formatMarketingBrandTitle("de")}</title>`);

    expect(enPricing).toContain(
      `<title>${formatMarketingPageTitle("en", "marketing.pricing.page_title")}</title>`,
    );
    expect(dePricing).toContain(
      `<title>${formatMarketingPageTitle("de", "marketing.pricing.page_title")}</title>`,
    );

    expect(enPricing).toContain(t("en", "marketing.pricing.plan.personal"));
    expect(enPricing).toContain('data-pricing-plan="personal"');
    expect(enPricing).toContain('data-pricing-root');
    expect(dePricing).toContain(t("de", "marketing.pricing.plan.personal"));
    expect(enPrivacy).toContain("Fly.io");
    expect(enPrivacy).toContain("Neon Postgres");
    expect(enPrivacy).toContain("Cloudflare");

    expect(enContact).toContain(
      `<title>${formatMarketingPageTitle("en", "marketing.contact.page_title")}</title>`,
    );
    expect(enContact).toContain(t("en", "marketing.contact.headline"));
    expect(enContact).toContain('id="contact-form"');
    expect(deContact).toContain(t("de", "marketing.contact.headline"));
    expect(deContact).toContain('lang="de"');

    const en404 = readFileSync(join(packageRoot, "dist/404.html"), "utf8");
    const de404 = readFileSync(join(packageRoot, "dist/de/404/index.html"), "utf8");
    const en500 = readFileSync(join(packageRoot, "dist/500.html"), "utf8");

    expect(en404).toContain(
      `<title>${formatMarketingPageTitle("en", "marketing.error.404.title")}</title>`,
    );
    expect(en404).toContain(t("en", "marketing.error.404.title"));
    expect(en404).toContain(t("en", "marketing.error.action.home"));
    expect(de404).toContain(t("de", "marketing.error.404.title"));
    expect(de404).toContain(t("de", "marketing.error.action.home"));
    expect(en500).toContain(t("en", "marketing.error.500.title"));
    expect(en500).toContain(t("en", "marketing.error.action.reload"));
  });
});
