import { describe, expect, it } from "vitest";
import { staticMessages, supportedLocales } from "./messages.js";
import { t } from "./translate.js";

const landingKeys = Object.keys(staticMessages.en).filter((key) =>
  key.startsWith("marketing.landing."),
) as (keyof (typeof staticMessages)["en"])[];

describe("marketing landing locales", () => {
  for (const locale of supportedLocales) {
    it(`loads catalog for ${locale}`, () => {
      expect(t(locale, "marketing.landing.hero_title")).toBeTruthy();
    });

    it(`renders landing hero in ${locale}`, () => {
      const title = t(locale, "marketing.landing.hero_title");
      const accent = t(locale, "marketing.landing.hero_title_accent");
      expect(title.length).toBeGreaterThan(0);
      expect(accent.length).toBeGreaterThan(0);
      expect(`${title} ${accent}`).not.toContain("marketing.landing.");
    });
  }

  it("has German translations for every English marketing key", () => {
    const enKeys = Object.keys(staticMessages.en);
    for (const key of enKeys) {
      const deKey = key as keyof (typeof staticMessages)["de"];
      expect(staticMessages.de[deKey]).toBeDefined();
      expect(staticMessages.de[deKey].length).toBeGreaterThan(0);
    }
  });

  it("covers all landing keys in both locales", () => {
    for (const locale of supportedLocales) {
      for (const key of landingKeys) {
        expect(t(locale, key).length).toBeGreaterThan(0);
      }
    }
  });
});
