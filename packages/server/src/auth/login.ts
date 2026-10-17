import { normalizeEmail, type MailPort } from "@slugbase/core";
import type { AuthStore } from "@slugbase/db";
import { uuidv7 } from "./uuidv7.ts";
import type { PasswordVerifier } from "./password.ts";
import { newSessionToken } from "./session-token.ts";
import { newSignInJobs } from "./sign-in-alert.ts";

// Password sign-in (doc 02 section 2.3, doc 04 section 4.5, doc 10 T8 and T17):
// the credentials are checked, and only then a session is created. A correct
// password alone never makes a full session for an account whose second factor
// is on: that session is partial until a code completes it.
//
// A full session from a device the account has not signed in from queues the "new sign-in" email in the
// transaction that creates the session (doc 02 section 12). A partial session queues none: the email for
// an account with a second factor is queued when the code completes the sign-in (mfa.ts).

export interface SignInRequest {
  /** As the person typed it. */
  readonly email: string;
  readonly password: string;
  readonly remember: boolean;
  /** SHA-256 of the token of the session cookie the request carried, if it was well-formed; that session ends. */
  readonly replacedTokenHash: Buffer | null;
  /** The coarse network of the client, or null when its address is unknown. */
  readonly ipPrefix: string | null;
  readonly userAgent: string | null;
}

export interface SignedIn {
  /** The cookie value of the new session. */
  readonly token: string;
  /**
   * `done` for a full session; `mfa` when the account has a second factor, which makes the session a
   * partial one that only `POST /auth/mfa/verify`, `POST /auth/logout` and `GET /api/config` accept.
   */
  readonly next: "done" | "mfa";
}

export interface SignInDependencies {
  readonly store: AuthStore;
  readonly passwords: PasswordVerifier;
  /** The mail port: the alert is queued only when it can send. */
  readonly mail: Pick<MailPort, "available">;
}

/**
 * Signs an account in with its password. Resolves to the new session token and
 * what comes next, or to undefined when the sign-in fails; the failure is one outcome whatever the
 * reason (an unknown email, a wrong password, an account without a password, a
 * disabled account), and every path verifies one argon2id hash, so they cannot
 * be told apart by the answer or by how long it takes. A new token is issued
 * and the session of the cookie the request carried is deleted in the same
 * database call, so a sign-in never leaves a session that the browser has
 * dropped, and a failed one deletes nothing. The alert for a new device is asked
 * for only once the password and the account are known good, and a session that
 * is not created queues none.
 */
export async function signIn(
  { store, passwords, mail }: SignInDependencies,
  request: SignInRequest,
): Promise<SignedIn | undefined> {
  const candidate = await store.loginLookup(normalizeEmail(request.email));
  const verified = await passwords.verify(candidate?.passwordHash, request.password);
  if (candidate === undefined || !verified || candidate.disabledAt !== null) {
    return undefined;
  }

  // Asked only once the password is right, so the answer says nothing to someone who does not know it.
  const second = await store.mfaStateOf(candidate.accountId);
  const next = second !== undefined && second.enabledAt !== null ? "mfa" : "done";
  const token = newSessionToken();
  const sessionId = uuidv7();
  const jobs = next === "done" && mail.available ? await newSignInJobs(store, candidate.accountId, request, new Date()) : [];
  const created = await store.createSession({
    id: sessionId,
    accountId: candidate.accountId,
    level: next === "mfa" ? "partial" : "full",
    remember: request.remember,
    ipPrefix: request.ipPrefix,
    userAgent: request.userAgent,
    tokenHash: token.hash,
    replacedTokenHash: request.replacedTokenHash,
    jobs,
  });
  return created ? { token: token.value, next } : undefined;
}
