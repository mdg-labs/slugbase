import { describe, expect, it } from "vitest";
import {
  MARKETING_KEY_PREFIX,
  mergeLocaleCatalogs,
  splitMergedCatalog,
  planPullApply,
  enKeySetChanged,
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

describe("planPullApply", () => {
  it("blocks when repo keys are missing on Tolgee", () => {
    const localMap = new Map([
      ["auth.login.title", "Login"],
      ["auth.login.new_key", "New"],
    ]);
    const remoteMap = new Map([["auth.login.title", "Login"]]);
    const plan = planPullApply({ localMap, remoteMap });
    expect(plan.canApply).toBe(false);
    expect(plan.blockReason).toContain("i18n:push");
  });

  it("applies value updates and orphan keys from Tolgee", () => {
    const localMap = new Map([
      ["auth.login.title", "Login"],
      ["marketing.hero.title", "Old hero"],
    ]);
    const remoteMap = new Map([
      ["auth.login.title", "Sign in"],
      ["marketing.hero.title", "New hero"],
      ["settings.billing.title", "Billing"],
    ]);
    const plan = planPullApply({ localMap, remoteMap });
    expect(plan.canApply).toBe(true);
    expect(plan.stats?.valueUpdates).toBe(2);
    expect(plan.stats?.orphansAdded).toBe(1);
    expect(plan.stats?.orphansAddedWeb).toBe(1);
    expect(plan.web?.["auth.login.title"]).toBe("Sign in");
    expect(plan.web?.["settings.billing.title"]).toBe("Billing");
    expect(plan.marketing?.["marketing.hero.title"]).toBe("New hero");
  });

  it("classifies orphan marketing keys by prefix", () => {
    const localMap = new Map([["auth.login.title", "Login"]]);
    const remoteMap = new Map([
      ["auth.login.title", "Login"],
      [`${MARKETING_KEY_PREFIX}footer.tagline`, "Tagline"],
    ]);
    const plan = planPullApply({ localMap, remoteMap });
    expect(plan.canApply).toBe(true);
    expect(plan.stats?.orphansAddedMarketing).toBe(1);
    expect(plan.stats?.orphansAddedWeb).toBe(0);
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
