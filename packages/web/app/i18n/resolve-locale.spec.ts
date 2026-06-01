import { describe, expect, it } from "vitest";

import { parseAcceptLanguage, resolveLocale } from "./resolve-locale.js";

describe("parseAcceptLanguage", () => {
  it("returns null for empty headers", () => {
    expect(parseAcceptLanguage(null)).toBeNull();
    expect(parseAcceptLanguage("")).toBeNull();
  });

  it("prefers higher quality values", () => {
    expect(parseAcceptLanguage("en;q=0.5, de;q=0.9")).toBe("de");
    expect(parseAcceptLanguage("de;q=0.4, en;q=0.8")).toBe("en");
  });

  it("matches regional tags", () => {
    expect(parseAcceptLanguage("de-AT, en-US;q=0.8")).toBe("de");
    expect(parseAcceptLanguage("en-GB")).toBe("en");
  });
});

describe("resolveLocale", () => {
  it("prefers signed-in user language", () => {
    expect(
      resolveLocale({
        userLanguage: "de",
        acceptLanguage: "en-US, en;q=0.9",
      }),
    ).toBe("de");
  });

  it("falls back to Accept-Language when user language is absent", () => {
    expect(
      resolveLocale({
        userLanguage: null,
        acceptLanguage: "de-DE, de;q=0.9, en;q=0.8",
      }),
    ).toBe("de");
  });

  it("defaults to en when nothing matches", () => {
    expect(resolveLocale({ userLanguage: "fr", acceptLanguage: "fr-FR" })).toBe("en");
    expect(resolveLocale({})).toBe("en");
  });
});
