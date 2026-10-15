import {
  generateBackupCodes,
  generateTotpSecret,
  base32Encode,
  otpauthUri,
  verifyTotp,
  type SecretBoxOptions,
  type SecretBoxPort,
} from "@slugbase/core";
import type { AuthStore } from "@slugbase/db";
import { newSessionToken } from "./session-token.ts";
import { uuidv7 } from "./uuidv7.ts";

// Enrolling the second factor (doc 02 section 2.7, doc 04 sections 4.4 and
// 10.3, doc 10 T7 and T17). The secret is generated here, sealed by the secret
// box before it is stored, and shown once, as the text key, the otpauth URI
// and the QR code; no operation returns it again. A secret, a code and a
// backup code are never logged, put in a problem document or kept past the
// request: the plaintext secret is zeroed as soon as the response or the
// check is done with it.

export interface MfaDependencies {
  readonly store: Pick<AuthStore, "mfaStateOf" | "startMfaEnrollment" | "resealMfaSecret" | "activateMfa">;
  readonly secretBox: Pick<SecretBoxPort, "seal" | "open" | "needsRotation" | "reseal">;
  /** Hashes a backup code into an argon2id PHC string. */
  readonly hashCode: (code: string) => Promise<string>;
  /** The instant a code is checked at, in milliseconds since the epoch. */
  readonly now: () => number;
  /** The name an authenticator app lists the account under. */
  readonly issuer: string;
  /** The QR code of a text as an SVG document. */
  readonly renderQr: (text: string) => string;
}

/**
 * What binds a sealed secret to where it is stored, so a ciphertext copied to another account's row
 * does not open there (the table, the column and the row).
 */
export function mfaSecretOptions(accountId: string): SecretBoxOptions {
  return { aad: new TextEncoder().encode(`accounts.mfa_secret:${accountId}`) };
}

export interface EnrollmentStart {
  readonly accountId: string;
  /** The account's email, which labels the entry in the authenticator app. */
  readonly email: string;
}

export type EnrollmentStartOutcome =
  | {
      readonly kind: "started";
      /** The secret as the base32 text key. */
      readonly secret: string;
      readonly otpauthUri: string;
      readonly qrSvg: string;
    }
  /** The account's second factor is already on, or the account cannot enrol; nothing was written. */
  | { readonly kind: "already_enabled" };

/**
 * Stores a new pending secret, sealed, in place of any earlier unconfirmed one, and describes it for
 * the authenticator app. Sign-in is unchanged: only confirming a code turns the factor on. The store
 * refuses an account whose factor is on, whatever this function was told before.
 */
export async function startEnrollment(dependencies: MfaDependencies, request: EnrollmentStart): Promise<EnrollmentStartOutcome> {
  const secret = generateTotpSecret();
  try {
    const sealed = await dependencies.secretBox.seal(secret, mfaSecretOptions(request.accountId));
    if (!(await dependencies.store.startMfaEnrollment(request.accountId, sealed))) {
      return { kind: "already_enabled" };
    }
    const text = base32Encode(secret);
    const uri = otpauthUri({ issuer: dependencies.issuer, account: request.email, secret: text });
    return { kind: "started", secret: text, otpauthUri: uri, qrSvg: dependencies.renderQr(uri) };
  } finally {
    secret.fill(0);
  }
}

export interface EnrollmentConfirmation {
  readonly accountId: string;
  /** The full session the confirmation is made from; it continues under a new token. */
  readonly sessionId: string;
  readonly code: string;
}

export type EnrollmentConfirmOutcome =
  /** The factor is on. `token` is the cookie value of the session from now on; `backupCodes` are shown once. */
  | { readonly kind: "enabled"; readonly token: string; readonly backupCodes: readonly string[] }
  /** The code is wrong, outside the window or already used; nothing was written. */
  | { readonly kind: "invalid_code" }
  /** There is no pending enrolment (never started, replaced meanwhile, or already confirmed); nothing was written. */
  | { readonly kind: "no_enrolment" }
  /** The session no longer exists; nothing was written. */
  | { readonly kind: "no_session" };

/**
 * Turns the factor on when `code` is a valid code of the pending secret. The code is verified before
 * anything is hashed or written. A secret still sealed under a retired key is sealed again under the
 * current one in the same pass, and only the secret that was verified can be activated. The accepted
 * time step, the activation, the ten backup codes (stored as argon2id hashes) and the session's new
 * token are then written by one store call in one transaction, so a failure leaves no half-enabled
 * factor, no codes and the old token.
 */
export async function confirmEnrollment(dependencies: MfaDependencies, request: EnrollmentConfirmation): Promise<EnrollmentConfirmOutcome> {
  const { store, secretBox } = dependencies;
  const state = await store.mfaStateOf(request.accountId);
  if (state === undefined || state.enabledAt !== null) {
    return { kind: "no_enrolment" };
  }
  const options = mfaSecretOptions(request.accountId);
  const secret = await secretBox.open(state.secret, options);
  let step: number | undefined;
  try {
    step = verifyTotp(secret, request.code, dependencies.now());
  } finally {
    secret.fill(0);
  }
  if (step === undefined) {
    return { kind: "invalid_code" };
  }

  let stored = state.secret.ciphertext;
  if (await secretBox.needsRotation(state.secret.keyId)) {
    const resealed = await secretBox.reseal(state.secret, options);
    if (!(await store.resealMfaSecret(request.accountId, stored, resealed))) {
      return { kind: "no_enrolment" };
    }
    stored = resealed.ciphertext;
  }

  const plain = generateBackupCodes();
  const records = await Promise.all(plain.map(async (code) => ({ id: uuidv7(), hash: await dependencies.hashCode(code) })));
  const token = newSessionToken();
  const outcome = await store.activateMfa({
    accountId: request.accountId,
    sessionId: request.sessionId,
    step,
    secret: stored,
    backupCodes: records,
    newTokenHash: token.hash,
  });
  switch (outcome) {
    case "activated":
      return { kind: "enabled", token: token.value, backupCodes: plain };
    case "replayed":
      return { kind: "invalid_code" };
    case "changed":
      return { kind: "no_enrolment" };
    case "no_session":
      return { kind: "no_session" };
  }
}
