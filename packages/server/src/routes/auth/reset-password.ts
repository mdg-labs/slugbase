import { resetPassword } from "@slugbase/contracts";
import { hashCredentialToken, truncateUserAgent, type MailPort, type PasswordPolicy, type SessionCookieSpec } from "@slugbase/core";
import type { AuthStore } from "@slugbase/db";
import { readCookie, setSessionCookie } from "../../auth/cookie.ts";
import { hashSessionToken, newSessionToken } from "../../auth/session-token.ts";
import { uuidv7 } from "../../auth/uuidv7.ts";
import type { RouteBinding } from "../../http/chain.ts";
import { ProblemError } from "../../http/problem.ts";
import { networkPrefixOf } from "../../http/trusted-proxy.ts";
import { queueMailSend } from "../../worker/jobs/mail-send.ts";
import { route } from "../register.ts";

// POST /api/v1/auth/password/reset (doc 04 sections 4.5 and 10.2, doc 02 section 2.5, doc 10 T4, T8 and T17).
// The emailed token is redeemed once: the password is replaced, every session of the account ends and a fresh
// session is created, and the "password changed" mail job is queued, all in one database transaction, so a
// failure at any step leaves the token unused and the old password in force, and the notice exists exactly
// when the reset does. The fresh session is partial for an account with a second factor, so a mailbox
// that is not the account's alone cannot skip it.
//
// The password is checked against the policy before the token is touched, so a weak password does not spend
// it, and it is hashed whatever the token turns out to be, so an unknown token costs what a valid one does. An
// unknown, used, expired, replaced or foreign token is one answer.

const REFUSED = "The link is invalid or has expired.";
const LENGTH_DETAIL = "The password must be 12 to 256 characters long.";
const BREACHED_DETAIL = "The password appears in a list of breached passwords. Choose a different one.";

export interface ResetPasswordRouteOptions {
  readonly store: Pick<AuthStore, "resetPassword">;
  /** The password policy every password-setting flow goes through. */
  readonly passwordPolicy: PasswordPolicy;
  /** Hashes the password into an argon2id PHC string. */
  readonly hashPassword: (password: string) => Promise<string>;
  readonly cookie: SessionCookieSpec;
  /** The mail port: the "password changed" email is queued only when it can send. */
  readonly mail: Pick<MailPort, "available">;
}

export function resetPasswordRoute({ store, passwordPolicy, hashPassword, cookie, mail }: ResetPasswordRouteOptions): RouteBinding {
  return route(resetPassword).handle(async ({ body }, context) => {
    const problems = passwordPolicy.check(body.newPassword);
    if (problems.length > 0) {
      throw new ProblemError("weak_password", problems.includes("breached") ? BREACHED_DETAIL : LENGTH_DETAIL, {
        errors: problems.map((code) => ({ path: "newPassword", code })),
      });
    }

    const passwordHash = await hashPassword(body.newPassword);
    const tokenHash = hashCredentialToken(body.token);
    if (tokenHash === undefined) {
      throw new ProblemError("token_expired", REFUSED);
    }

    const header = context.req.raw.headers.get("cookie");
    const carried = header === null ? undefined : readCookie(header, cookie.name);
    const session = newSessionToken();
    const outcome = await store.resetPassword({
      tokenHash,
      passwordHash,
      sessionId: uuidv7(),
      sessionTokenHash: session.hash,
      ipPrefix: networkPrefixOf(context.get("clientIp")) ?? null,
      userAgent: truncateUserAgent(context.req.raw.headers.get("user-agent")),
      replacedTokenHash: carried === undefined ? null : (hashSessionToken(carried) ?? null),
      jobsOnReset: (accountId) => (mail.available ? [queueMailSend(uuidv7(), "passwordChanged", accountId)] : []),
    });
    if (outcome === undefined) {
      throw new ProblemError("token_expired", REFUSED);
    }
    return { status: 200, headers: { "Set-Cookie": setSessionCookie(cookie, session.value) }, body: { next: outcome.next } };
  });
}
