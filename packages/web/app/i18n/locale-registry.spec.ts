import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import supportedLocalesJson from "../../../../i18n/supported-locales.json";
import { SUPPORTED_APP_LOCALES } from "./resolve-locale.js";

const repoRoot = join(process.cwd(), "../..");
const webLocalesDir = join(repoRoot, "packages/web/app/i18n/locales");

describe("i18n supported locale registry", () => {
  it("matches web AppLocale list", () => {
    expect([...SUPPORTED_APP_LOCALES]).toEqual(supportedLocalesJson);
  });

  it("has locale JSON files in web", () => {
    for (const locale of supportedLocalesJson) {
      expect(existsSync(join(webLocalesDir, `${locale}.json`))).toBe(true);
    }
  });
});
