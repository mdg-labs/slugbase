import { generateCredentialToken } from "../auth/credential-tokens.ts";

// The recovery operations of the CE instance admin (doc 02 sections 2.5, 2.6, 2.7 and 11.2, doc 04 section 10.10, doc 05
// sections 3.3, doc 10 T7, T17 and T18): reset an account's second factor, issue it a password-reset token, and ask for a
// new verification email. Marking an address verified is a field of the account change (`accounts.ts`). Each is a
// `sys_instance_*` system operation that checks the admin again in the database and writes its instance audit event in the
// same call, so this module decides what is asked and how an answer is read, and never writes an event itself.
//
// The queued emails carry the account's identifier and a template, never an address or a token: the mail job makes the token
// of a reset or verification email when it runs. The one token made here is the password-reset link that is handed back to
// the admin where no mail can carry it; it is returned to the caller once, only its hash is stored, and nothing here logs it.

/** Where the reset link leads: the reset page of the application, on the deployment's own origin, with the token in the fragment. */
const RESET_PATH = "/reset-password#token=";

/** The reset link for `token` on the deployment `origin`. */
export function passwordResetLink(origin: string, token: string): string {
  return `${new URL(origin).origin}${RESET_PATH}${token}`;
}

/** What a reset of an account's second factor did. */
export type InstanceMfaResetOutcome =
  /** The second factor was on and is off; every session of the account is gone and the audit event is written. */
  | "reset"
  /** The account has no confirmed second factor; nothing was written, deleted or queued. */
  | "mfa_not_enabled"
  | "account_disabled"
  /** The target is the calling admin, who turns their own second factor off with the second factor that asks for. */
  | "self"
  | "unknown_account";

/** Why no password-reset token was issued; nothing was written. */
export type InstanceResetLinkRefusal = "account_disabled" | "email_unverified" | "no_password" | "unknown_account";

/**
 * What the database said to a request for a password-reset token. `link_required` is the answer to a request for the mail
 * about an account with no password and no linked provider identity, which the mail job would not send to; nothing was
 * written, and the request is made again with a token.
 */
export type InstanceResetLinkStoreOutcome = "issued" | "link_required" | InstanceResetLinkRefusal;

/** Why no verification email was requested; nothing was written. */
export type InstanceVerificationRefusal = "already_verified" | "account_disabled" | "unknown_account";

export type InstanceVerificationOutcome = "requested" | InstanceVerificationRefusal;

/** The recovery operations of the instance admin, bound to the account-level transaction of the request. */
export interface InstanceRecoveryStore {
  /**
   * Turns the account's second factor off and deletes its sessions, with the audit event, in one call. When `notify` is
   * set and the answer is `reset`, the "your second factor was reset" email is queued in the same transaction.
   */
  resetMfa(accountId: string, eventId: string, notify: boolean, ipPrefix: string | null): Promise<InstanceMfaResetOutcome>;
  /**
   * Vouches that the account may be sent a password-reset token and writes the audit event. With `token` the one-hour token
   * is stored (as its hash) in the same call and replaces the account's earlier unused one; without it the password-reset
   * email is queued in the same transaction, and the mail job makes the token when it runs.
   */
  issueResetLink(
    accountId: string,
    eventId: string,
    token: { readonly id: string; readonly hash: Buffer } | undefined,
    ipPrefix: string | null,
  ): Promise<InstanceResetLinkStoreOutcome>;
  /** Writes the audit event and queues the verification email in the same transaction, for an enabled account with an unverified address. */
  requestVerification(accountId: string, eventId: string, ipPrefix: string | null): Promise<InstanceVerificationOutcome>;
}

export interface InstanceRecoveryDependencies {
  readonly store: InstanceRecoveryStore;
  /** A fresh UUIDv7. */
  readonly newId: () => string;
}

export interface InstanceRecoveryAsk {
  readonly accountId: string;
  /** The coarse network of the request, null when unknown. */
  readonly ipPrefix: string | null;
}

export interface InstanceMfaResetAsk extends InstanceRecoveryAsk {
  /** Whether the email that tells the account can be queued, that is, whether mail is configured. */
  readonly notify: boolean;
}

/** Turns the second factor of the account off; the secret is cleared in the database and never read. */
export function resetInstanceAccountMfa({ store, newId }: InstanceRecoveryDependencies, ask: InstanceMfaResetAsk): Promise<InstanceMfaResetOutcome> {
  return store.resetMfa(ask.accountId, newId(), ask.notify, ask.ipPrefix);
}

export interface InstanceResetLinkAsk extends InstanceRecoveryAsk {
  /** Whether a mail adapter is configured: the link is mailed then, and handed back only when it is not. */
  readonly mailAvailable: boolean;
  /** `APP_ORIGIN`: the returned link points to it. */
  readonly origin: string;
}

/** What a request for a reset link did. */
export type InstanceResetLinkOutcome =
  /** The password-reset email is queued; no link is returned, since the email carries it. */
  | { readonly kind: "mailed" }
  /** No mail can carry it: the link, valid for one hour, is returned here and nowhere else. */
  | { readonly kind: "link"; readonly link: string }
  | { readonly kind: InstanceResetLinkRefusal };

/**
 * Issues a one-hour password-reset token for the account (doc 02 section 11.2): mailed to the account where mail is
 * configured, and then no link leaves the server; handed back once as a link where it is not, and where the account has
 * no password for the mail job to send to (what marking its address verified leaves).
 */
export async function issueInstanceResetLink({ store, newId }: InstanceRecoveryDependencies, ask: InstanceResetLinkAsk): Promise<InstanceResetLinkOutcome> {
  const first = ask.mailAvailable ? undefined : generateCredentialToken();
  let token = first;
  let outcome = await store.issueResetLink(ask.accountId, newId(), first === undefined ? undefined : { id: newId(), hash: first.hash }, ask.ipPrefix);
  if (outcome === "link_required") {
    // The mail would not be sent to this account, so the admin is handed the link instead.
    token = generateCredentialToken();
    outcome = await store.issueResetLink(ask.accountId, newId(), { id: newId(), hash: token.hash }, ask.ipPrefix);
  }
  if (outcome === "link_required") {
    throw new Error("the store asked for a link although the request carried a token");
  }
  if (outcome !== "issued") {
    return { kind: outcome };
  }
  return token === undefined ? { kind: "mailed" } : { kind: "link", link: passwordResetLink(ask.origin, token.value) };
}

/** Asks for a new verification email for the account; the mail job makes the token. */
export function requestInstanceAccountVerification({ store, newId }: InstanceRecoveryDependencies, ask: InstanceRecoveryAsk): Promise<InstanceVerificationOutcome> {
  return store.requestVerification(ask.accountId, newId(), ask.ipPrefix);
}
