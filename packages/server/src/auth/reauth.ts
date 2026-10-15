import type { PasswordPolicy, PasswordProblem } from "@slugbase/core";
import type { AuthStore, QueuedJob } from "@slugbase/db";
import type { PasswordVerifier } from "./password.ts";
import { newSessionToken } from "./session-token.ts";

// Re-authentication and the password change (doc 04 sections 4.3, 4.4 and
// 10.3, doc 10 T4 and T18). Both check a typed password against the stored
// hash through the one verifier sign-in uses: it costs one argon2id
// verification whether the account has a usable hash or not, so a wrong
// password, an account without a password and a hash the library cannot read
// are one outcome that takes the same time.

export interface ReauthDependencies {
  readonly store: Pick<AuthStore, "passwordHashOf" | "markReauthenticated">;
  readonly passwords: PasswordVerifier;
}

export interface ReauthRequest {
  readonly accountId: string;
  /** The full session that re-authenticates. */
  readonly sessionId: string;
  readonly password: string;
}

export type ReauthOutcome =
  /** `reauth_at` of the session is now. */
  | "reauthenticated"
  /** The password is wrong or the account has none; nothing was written. */
  | "wrong_password"
  /** The session no longer exists; nothing was written. */
  | "no_session";

/** Whether `password` is the account's password, at the cost of one argon2id verification whether or not the account has one. */
export async function passwordMatches(
  { store, passwords }: { readonly store: Pick<AuthStore, "passwordHashOf">; readonly passwords: PasswordVerifier },
  accountId: string,
  password: string,
): Promise<boolean> {
  return passwords.verify(await store.passwordHashOf(accountId), password);
}

/** Sets `reauth_at` of the session after the account's password is verified; a failed check changes nothing. */
export async function reauthenticate(dependencies: ReauthDependencies, request: ReauthRequest): Promise<ReauthOutcome> {
  if (!(await passwordMatches(dependencies, request.accountId, request.password))) {
    return "wrong_password";
  }
  return (await dependencies.store.markReauthenticated(request.sessionId, request.accountId)) ? "reauthenticated" : "no_session";
}

export interface PasswordChangeDependencies extends ReauthDependencies {
  readonly store: Pick<AuthStore, "passwordHashOf" | "markReauthenticated" | "changePassword">;
  readonly passwordPolicy: PasswordPolicy;
  /** Hashes the new password into an argon2id PHC string. */
  readonly hashPassword: (password: string) => Promise<string>;
  /**
   * The jobs a change of this account's password puts on their queues, in the transaction that writes
   * the change (the email that tells the account about it). None when it returns an empty list.
   */
  readonly jobsOnChange?: (accountId: string) => readonly QueuedJob[];
}

export interface PasswordChangeRequest {
  readonly accountId: string;
  /** The full session the change is made from; it continues under a new token. */
  readonly sessionId: string;
  readonly currentPassword: string;
  readonly newPassword: string;
}

export type PasswordChangeOutcome =
  /** `token` is the cookie value of the session from now on; every other session of the account is gone. */
  | { readonly kind: "changed"; readonly token: string }
  /** The policy refuses the new password; nothing was written. */
  | { readonly kind: "weak_password"; readonly problems: readonly PasswordProblem[] }
  /** The current password is wrong or the account has none; nothing was written. */
  | { readonly kind: "wrong_password" }
  /** The account or the session no longer exists; nothing was written. */
  | { readonly kind: "no_session" };

/**
 * Changes the password of the account of the session. The new password is checked
 * against the policy and the current one is verified before anything is hashed or
 * written. The stored hash, the deletion of the account's other sessions and the
 * session's new token are then written by one store call in one transaction, together
 * with the jobs the change announces, so a failure leaves the old password, the old
 * sessions, the old token and no job.
 */
export async function changePassword(dependencies: PasswordChangeDependencies, request: PasswordChangeRequest): Promise<PasswordChangeOutcome> {
  const problems = dependencies.passwordPolicy.check(request.newPassword);
  if (problems.length > 0) {
    return { kind: "weak_password", problems };
  }
  if (!(await passwordMatches(dependencies, request.accountId, request.currentPassword))) {
    return { kind: "wrong_password" };
  }
  const token = newSessionToken();
  const changed = await dependencies.store.changePassword({
    accountId: request.accountId,
    sessionId: request.sessionId,
    passwordHash: await dependencies.hashPassword(request.newPassword),
    newTokenHash: token.hash,
    jobs: dependencies.jobsOnChange?.(request.accountId) ?? [],
  });
  return changed ? { kind: "changed", token: token.value } : { kind: "no_session" };
}
