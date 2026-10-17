import { describe, expect, it } from "vitest";
import { registrationLocale, registrationUnavailable } from "../../src/auth/registration.ts";

describe("registrationUnavailable", () => {
  it("is closed whenever public registration is off, whether or not mail can be sent", () => {
    for (const emailVerificationRequired of [true, false]) {
      for (const mail of [true, false]) {
        expect(registrationUnavailable({ publicRegistration: false, emailVerificationRequired }, mail)).toBe("registration_closed");
      }
    }
  });

  it("cannot take a registration that must be verified when no mail can be sent", () => {
    expect(registrationUnavailable({ publicRegistration: true, emailVerificationRequired: true }, false)).toBe("mail_unavailable");
  });

  it("takes a registration that must be verified when mail can be sent, and one that need not be, with or without mail", () => {
    expect(registrationUnavailable({ publicRegistration: true, emailVerificationRequired: true }, true)).toBeUndefined();
    expect(registrationUnavailable({ publicRegistration: true, emailVerificationRequired: false }, true)).toBeUndefined();
    expect(registrationUnavailable({ publicRegistration: true, emailVerificationRequired: false }, false)).toBeUndefined();
  });
});

describe("registrationLocale", () => {
  it.each([
    ["de", "de"],
    ["de-AT,de;q=0.9,en;q=0.8", "de"],
    ["fr-CH, fr;q=0.9, de;q=0.8", "de"],
    ["EN-us", "en"],
    ["en,de", "en"],
  ])("reads %s as %s", (header, locale) => {
    expect(registrationLocale(header)).toBe(locale);
  });

  it.each([[null], [""], ["fr"], ["*"], ["xx-DE"], [";q=0.1"]])("falls back to English for %j", (header) => {
    expect(registrationLocale(header)).toBe("en");
  });
});
