import { describe, expect, it } from "vitest";
import {
  MARKETING_KEY_PREFIX,
  mergeLocaleCatalogs,
  splitMergedCatalog,
  enKeySetChanged,
  findEmptyCatalogKeys,
} from "./i18n-catalog-utils.mjs";

describe("splitMergedCatalog", () => {
  it("routes marketing.* keys to marketing bucket", () => {
    const merged = {
      "dashboard.title": "Dashboard",
      "marketing.hero.title": "Hero",
      "settings.account.title": "Account",
    };
    const { web, marketing } = splitMergedCatalog(merged);
    expect(Object.keys(web)).toEqual(["dashboard.title", "settings.account.title"]);
    expect(Object.keys(marketing)).toEqual(["marketing.hero.title"]);
  });

  it("round-trips with mergeLocaleCatalogs", () => {
    const web = { "auth.login.title": "Login", "bookmark.list.empty": "Empty" };
    const marketing = {
      "marketing.contact.headline": "Contact",
      "marketing.pricing.title": "Pricing",
    };
    const merged = mergeLocaleCatalogs(web, marketing);
    const split = splitMergedCatalog(merged);
    expect(split.web).toEqual(web);
    expect(split.marketing).toEqual(marketing);
  });
});

describe("findEmptyCatalogKeys", () => {
  it("returns keys with blank values", () => {
    expect(findEmptyCatalogKeys({ "a.b": "ok", "c.d": "  ", "e.f": "" })).toEqual([
      "c.d",
      "e.f",
    ]);
  });
});

describe("enKeySetChanged", () => {
  it("detects added keys", () => {
    expect(enKeySetChanged(["a", "b"], ["a", "b", "c"])).toBe(true);
  });

  it("returns false when key sets match", () => {
    expect(enKeySetChanged(["b", "a"], ["a", "b"])).toBe(false);
  });
});

describe("MARKETING_KEY_PREFIX", () => {
  it("is marketing.", () => {
    expect(MARKETING_KEY_PREFIX).toBe("marketing.");
  });
});
