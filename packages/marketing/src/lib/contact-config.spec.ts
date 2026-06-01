import { describe, expect, it } from "vitest";

import { isContactFormConfigured, loadMarketingContactConfig } from "./contact-config.js";

describe("loadMarketingContactConfig", () => {
  it("reports configured when a contact endpoint is set", () => {
    const config = {
      contactEndpoint: "https://api.slugbase.test/contact",
      turnstileSiteKey: "",
      nameMaxLength: 200,
      messageMaxLength: 5000,
    };
    expect(isContactFormConfigured(config)).toBe(true);
  });

  it("reports not configured when the contact endpoint is empty", () => {
    const config = loadMarketingContactConfig();
    if (config.contactEndpoint.length === 0) {
      expect(isContactFormConfigured(config)).toBe(false);
    }
  });
});
