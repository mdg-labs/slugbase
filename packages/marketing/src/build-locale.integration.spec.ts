import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { t } from "./i18n/tolgee.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("marketing build output", () => {
  it("builds and renders landing for en and de", () => {
    execSync("pnpm build", {
      cwd: packageRoot,
      stdio: "pipe",
      env: {
        ...process.env,
        PUBLIC_PLAN_PRICE_PERSONAL_MONTHLY: "$4/mo",
        PUBLIC_PLAN_PRICE_PERSONAL_YEARLY: "$3.33/mo",
        PUBLIC_PLAN_PRICE_TEAM_SEAT: "$9/seat/mo",
        PUBLIC_PLAN_PRICE_SUPPORTER: "$59",
      },
    });

    const enHtml = readFileSync(join(packageRoot, "dist/index.html"), "utf8");
    const deHtml = readFileSync(join(packageRoot, "dist/de/index.html"), "utf8");
    const enPricing = readFileSync(join(packageRoot, "dist/pricing/index.html"), "utf8");
    const dePricing = readFileSync(join(packageRoot, "dist/de/pricing/index.html"), "utf8");
    const enPrivacy = readFileSync(join(packageRoot, "dist/legal/datenschutz/index.html"), "utf8");

    expect(enHtml).toContain(t("en", "marketing.landing.hero_title"));
    expect(enHtml).toContain(t("en", "marketing.landing.hero_title_accent"));
    expect(deHtml).toContain(t("de", "marketing.landing.hero_title"));
    expect(deHtml).toContain(t("de", "marketing.landing.hero_title_accent"));
    expect(enHtml).toContain('lang="en"');
    expect(deHtml).toContain('lang="de"');

    expect(enPricing).toContain(t("en", "marketing.pricing.plan.personal"));
    expect(enPricing).toContain('data-price-monthly="$4"');
    expect(enPricing).toContain("$59");
    expect(dePricing).toContain(t("de", "marketing.pricing.plan.personal"));
    expect(enPrivacy).toContain("Fly.io");
    expect(enPrivacy).toContain("Neon Postgres");
    expect(enPrivacy).toContain("Cloudflare Workers");

    const en404 = readFileSync(join(packageRoot, "dist/404.html"), "utf8");
    const de404 = readFileSync(join(packageRoot, "dist/de/404/index.html"), "utf8");
    const en500 = readFileSync(join(packageRoot, "dist/500.html"), "utf8");

    expect(en404).toContain(t("en", "marketing.error.404.title"));
    expect(en404).toContain(t("en", "marketing.error.action.home"));
    expect(de404).toContain(t("de", "marketing.error.404.title"));
    expect(de404).toContain(t("de", "marketing.error.action.home"));
    expect(en500).toContain(t("en", "marketing.error.500.title"));
    expect(en500).toContain(t("en", "marketing.error.action.reload"));
  });
});
