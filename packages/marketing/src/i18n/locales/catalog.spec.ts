import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import supportedLocalesJson from "../../../../../i18n/supported-locales.json";

const localesDir = join(import.meta.dirname);

function readCatalog(locale: string): Record<string, string> {
  return JSON.parse(readFileSync(join(localesDir, `${locale}.json`), "utf8")) as Record<
    string,
    string
  >;
}

describe("marketing i18n locale JSON catalogs", () => {
  const defaultLocale = supportedLocalesJson[0];
  if (!defaultLocale) {
    throw new Error("supported-locales.json is empty");
  }

  it("has non-empty values for every key in the default locale", () => {
    const catalog = readCatalog(defaultLocale);
    for (const [key, value] of Object.entries(catalog)) {
      expect(value.length, key).toBeGreaterThan(0);
    }
  });

  for (const locale of supportedLocalesJson) {
    if (locale === defaultLocale) continue;

    it(`has the same keys as ${defaultLocale} in ${locale}`, () => {
      const enKeys = Object.keys(readCatalog(defaultLocale)).sort();
      const localeKeys = Object.keys(readCatalog(locale)).sort();
      expect(localeKeys).toEqual(enKeys);
    });

    it(`has non-empty values in ${locale}`, () => {
      const catalog = readCatalog(locale);
      for (const [key, value] of Object.entries(catalog)) {
        expect(value.length, key).toBeGreaterThan(0);
      }
    });
  }
});
