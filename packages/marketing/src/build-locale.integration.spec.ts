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
        PUBLIC_MARKETING_ORIGIN: "https://www.slugbase.test",
      },
    });

    const enHtml = readFileSync(join(packageRoot, "dist/index.html"), "utf8");
    const deHtml = readFileSync(join(packageRoot, "dist/de/index.html"), "utf8");
    const enBlog = readFileSync(join(packageRoot, "dist/blog/index.html"), "utf8");
    const deBlog = readFileSync(join(packageRoot, "dist/de/blog/index.html"), "utf8");
    const enRss = readFileSync(join(packageRoot, "dist/blog/rss.xml"), "utf8");
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
    expect(enHtml).toContain(t("en", "marketing.nav.blog"));
    expect(enHtml).toContain(t("en", "marketing.footer.blog"));
    expect(deHtml).toContain(t("de", "marketing.nav.blog"));
    expect(deHtml).toContain(t("de", "marketing.footer.blog"));
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

    expect(enBlog).toContain('lang="en"');
    expect(enBlog).toContain(
      `<title>${formatMarketingPageTitle("en", "marketing.blog.page_title")}</title>`,
    );
    expect(enBlog).toContain(t("en", "marketing.blog.index_headline"));
    expect(enBlog).toContain(t("en", "marketing.blog.index_description"));
    expect(enBlog).toContain(t("en", "marketing.nav.blog"));
    expect(enBlog).toContain(t("en", "marketing.footer.blog"));
    expect(enBlog).toContain('class="blog-post-list"');
    expect(deBlog).toContain('lang="de"');
    expect(deBlog).toContain(
      `<title>${formatMarketingPageTitle("de", "marketing.blog.page_title")}</title>`,
    );
    expect(deBlog).toContain(t("de", "marketing.blog.index_headline"));
    expect(deBlog).toContain(t("de", "marketing.blog.index_description"));
    expect(deBlog).toContain(t("de", "marketing.nav.blog"));
    expect(deBlog).toContain(t("de", "marketing.footer.blog"));
    expect(deBlog).toContain('class="blog-post-list"');

    expect(enRss).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(enRss).toContain("<rss");
    expect(enRss).toContain(`<link>https://www.slugbase.test</link>`);
    expect(enRss).toContain(t("en", "marketing.nav.brand"));

    const enIntroducingPost = readFileSync(
      join(packageRoot, "dist/blog/introducing-slugbase/index.html"),
      "utf8",
    );
    const deIntroducingPost = readFileSync(
      join(packageRoot, "dist/de/blog/slugbase-vorstellung/index.html"),
      "utf8",
    );

    expect(enIntroducingPost).toContain("Introducing SlugBase");
    expect(enIntroducingPost).toContain('lang="en"');
    expect(enIntroducingPost).toContain('href="/de/blog/slugbase-vorstellung"');
    expect(enBlog).toContain("Introducing SlugBase");
    expect(deIntroducingPost).toContain("SlugBase stellt sich vor");
    expect(deIntroducingPost).toContain('lang="de"');
    expect(deIntroducingPost).toContain('href="/blog/introducing-slugbase"');
    expect(deBlog).toContain("SlugBase stellt sich vor");

    expect(enRss).toContain("Introducing SlugBase");
    expect(enRss).toContain("SlugBase stellt sich vor");
  });
});
