// Self-registration (doc 02 section 2.2, doc 04 section 10.2, doc 10 T8). Whether a visitor may register and
// what the answer to the request cannot say are decided here from the deployment's settings alone: nothing
// in this file looks at the address, the password or whether an account exists.

/**
 * What the deployment decided about registration. The values are the operator's keys, with the defaults the
 * composition root supplies for any it left unset (doc 01 section 11): there is no edition to ask (D4).
 */
export interface RegistrationSettings {
  /** `PUBLIC_REGISTRATION`: a visitor may create an account. */
  readonly publicRegistration: boolean;
  /** `EMAIL_VERIFICATION_REQUIRED`: an account cannot sign in until its address is verified. */
  readonly emailVerificationRequired: boolean;
}

/** Why registration cannot take a request at all; the codes of the problem documents of doc 04 section 3.2. */
export type RegistrationUnavailable = "registration_closed" | "mail_unavailable";

/**
 * Why a registration cannot start, or undefined when it can. Closed registration is judged first, so a
 * closed deployment never reveals whether it can send mail; a deployment that requires verification and
 * cannot send mail refuses before it creates anything, because the account could never sign in.
 */
export function registrationUnavailable(settings: RegistrationSettings, mailAvailable: boolean): RegistrationUnavailable | undefined {
  if (!settings.publicRegistration) {
    return "registration_closed";
  }
  return settings.emailVerificationRequired && !mailAvailable ? "mail_unavailable" : undefined;
}

/** The languages an account can have (doc 02 section 15). */
export type RegistrationLocale = "en" | "de";

const DEFAULT_LOCALE: RegistrationLocale = "en";

/**
 * The language of the new account, from the visitor's `Accept-Language`: the first range, in the order the
 * header lists them, whose primary subtag is one the interface has; English when the header is missing or
 * names none. Quality values are not weighed: a browser lists its languages in order of preference.
 */
export function registrationLocale(acceptLanguage: string | null): RegistrationLocale {
  for (const range of (acceptLanguage ?? "").split(",")) {
    const primary = range.split(";")[0]?.trim().toLowerCase().split("-")[0];
    if (primary === "en" || primary === "de") {
      return primary;
    }
  }
  return DEFAULT_LOCALE;
}
