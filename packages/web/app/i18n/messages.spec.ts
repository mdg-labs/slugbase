import { describe, expect, it } from "vitest";

import { staticMessages } from "./messages.js";

describe("web i18n catalog", () => {
  it("has German translations for every English key", () => {
    const enKeys = Object.keys(staticMessages.en);
    for (const key of enKeys) {
      const deKey = key as keyof (typeof staticMessages)["de"];
      expect(staticMessages.de[deKey]).toBeDefined();
      expect(staticMessages.de[deKey].length).toBeGreaterThan(0);
    }
  });

  it("does not define extra German-only keys", () => {
    const deKeys = Object.keys(staticMessages.de);
    for (const key of deKeys) {
      const enKey = key as keyof (typeof staticMessages)["en"];
      expect(staticMessages.en[enKey]).toBeDefined();
    }
  });
});
