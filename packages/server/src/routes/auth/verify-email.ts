import { verifyEmail } from "@slugbase/contracts";
import { hashCredentialToken, truncateUserAgent, type PasswordPolicy, type SessionCookieSpec } from "@slugbase/core";
import type { AuthStore } from "@slugbase/db";
import { readCookie, setSessionCookie } from "../../auth/cookie.ts";
import { provisionWorkspaceIn } from "../../auth/personal-workspace.ts";
import { hashSessionToken, newSessionToken } from "../../auth/session-token.ts";
import { uuidv7 } from "../../auth/uuidv7.ts";
import type { RouteBinding } from "../../http/chain.ts";
import { ProblemError } from "../../http/problem.ts";
import { networkPrefixOf } from "../../http/trusted-proxy.ts";
import { route } from "../register.ts";

// POST /api/v1/auth/verify-email (doc 04 sections 4.5 and 10.2, doc 02 sections 2.2 and 2.6, doc 10 T4 and
// T8). The emailed token is redeemed once; the address is marked verified, the personal workspace is
// created and the account is signed in, all in one database transaction, so a failure at any step leaves
// the token unused. An account whose address was never verified is one a visitor registered, and the
// visitor is not necessarily the owner of the address: the owner chooses the password here, and it replaces
// the one the registration set, and every session the account had ends with it.
//
// The password is checked against the policy before the token is touched, so a weak password does not
// spend it, and it is hashed whatever the token turns out to be, so an unknown token costs what a
// valid one does. An unknown, used, expired or foreign token is one answer.

const REFUSED = "The link is invalid or has expired.";
const LENGTH_DETAIL = "The password must be 12 to 256 characters long.";
const BREACHED_DETAIL = "The password appears in a list of breached passwords. Choose a different one.";

export interface VerifyEmailRouteOptions {
  readonly store: Pick<AuthStore, "verifyEmail">;
  /** The password policy every password-setting flow goes through. */
  readonly passwordPolicy: PasswordPolicy;
  /** Hashes the password into an argon2id PHC string. */
  readonly hashPassword: (password: string) => Promise<string>;
  readonly cookie: SessionCookieSpec;
}

export function verifyEmailRoute({ store, passwordPolicy, hashPassword, cookie }: VerifyEmailRouteOptions): RouteBinding {
  return route(verifyEmail).handle(async ({ body }, context) => {
    const problems = passwordPolicy.check(body.password);
    if (problems.length > 0) {
      throw new ProblemError("weak_password", problems.includes("breached") ? BREACHED_DETAIL : LENGTH_DETAIL, {
        errors: problems.map((code) => ({ path: "password", code })),
      });
    }

    const passwordHash = await hashPassword(body.password);
    const tokenHash = hashCredentialToken(body.token);
    if (tokenHash === undefined) {
      throw new ProblemError("token_expired", REFUSED);
    }

    const header = context.req.raw.headers.get("cookie");
    const carried = header === null ? undefined : readCookie(header, cookie.name);
    const session = newSessionToken();
    const verified = await store.verifyEmail({
      tokenHash,
      passwordHash,
      sessionId: uuidv7(),
      sessionTokenHash: session.hash,
      ipPrefix: networkPrefixOf(context.get("clientIp")) ?? null,
      userAgent: truncateUserAgent(context.req.raw.headers.get("user-agent")),
      replacedTokenHash: carried === undefined ? null : (hashSessionToken(carried) ?? null),
      afterVerified: provisionWorkspaceIn,
    });
    if (verified === undefined) {
      throw new ProblemError("token_expired", REFUSED);
    }
    return { status: 200, headers: { "Set-Cookie": setSessionCookie(cookie, session.value) }, body: { next: verified.next } };
  });
}
