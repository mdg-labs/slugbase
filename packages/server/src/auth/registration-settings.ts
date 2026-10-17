import type { RegistrationSettings } from "@slugbase/core";
import type { ServerConfig } from "../config/index.ts";

// What `PUBLIC_REGISTRATION` and `EMAIL_VERIFICATION_REQUIRED` mean when the operator left them unset is the
// composition root's to say (doc 01 section 11, D4): the Community Edition opens no registration, SlugBase
// Cloud opens it and requires verification, and nothing here asks which one is running.

/**
 * The defaults a composition that passes none gets: registration closed, and an address that is verified
 * only when it can be (the Community Edition's, doc 02 section 2.2).
 */
export const DEFAULT_REGISTRATION: RegistrationSettings = { publicRegistration: false, emailVerificationRequired: false };

/** The settings in force: each key the operator set, else the composition's default for it. */
export function registrationSettings(
  config: Pick<ServerConfig, "PUBLIC_REGISTRATION" | "EMAIL_VERIFICATION_REQUIRED">,
  defaults: RegistrationSettings,
): RegistrationSettings {
  return {
    publicRegistration: config.PUBLIC_REGISTRATION ?? defaults.publicRegistration,
    emailVerificationRequired: config.EMAIL_VERIFICATION_REQUIRED ?? defaults.emailVerificationRequired,
  };
}
