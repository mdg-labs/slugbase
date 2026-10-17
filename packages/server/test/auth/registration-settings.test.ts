import { describe, expect, it } from "vitest";
import { DEFAULT_REGISTRATION, registrationSettings } from "../../src/auth/registration-settings.ts";

describe("registrationSettings", () => {
  const cloud = { publicRegistration: true, emailVerificationRequired: true };

  it("takes the composition's default for each key the operator left unset", () => {
    expect(registrationSettings({ PUBLIC_REGISTRATION: undefined, EMAIL_VERIFICATION_REQUIRED: undefined }, cloud)).toEqual(cloud);
    expect(registrationSettings({ PUBLIC_REGISTRATION: undefined, EMAIL_VERIFICATION_REQUIRED: undefined }, DEFAULT_REGISTRATION)).toEqual({
      publicRegistration: false,
      emailVerificationRequired: false,
    });
  });

  it("lets a key the operator set win over the default, including an explicit false", () => {
    expect(registrationSettings({ PUBLIC_REGISTRATION: false, EMAIL_VERIFICATION_REQUIRED: false }, cloud)).toEqual({
      publicRegistration: false,
      emailVerificationRequired: false,
    });
    expect(registrationSettings({ PUBLIC_REGISTRATION: true, EMAIL_VERIFICATION_REQUIRED: undefined }, DEFAULT_REGISTRATION)).toEqual({
      publicRegistration: true,
      emailVerificationRequired: false,
    });
  });

  it("decides each key on its own", () => {
    expect(registrationSettings({ PUBLIC_REGISTRATION: undefined, EMAIL_VERIFICATION_REQUIRED: false }, cloud)).toEqual({
      publicRegistration: true,
      emailVerificationRequired: false,
    });
  });
});
