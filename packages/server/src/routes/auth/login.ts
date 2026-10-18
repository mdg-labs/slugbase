import { login } from "@slugbase/contracts";
import { truncateUserAgent, type SessionCookieSpec } from "@slugbase/core";
import { emailLimitKey } from "../../auth/email-limit.ts";
import { readCookie, setSessionCookie } from "../../auth/cookie.ts";
import { signIn, type SignInDependencies } from "../../auth/login.ts";
import { hashSessionToken } from "../../auth/session-token.ts";
import type { RouteBinding } from "../../http/chain.ts";
import { ProblemError } from "../../http/problem.ts";
import { networkPrefixOf } from "../../http/trusted-proxy.ts";
import { route } from "../register.ts";

// POST /api/v1/auth/login (doc 04 section 10.2). Every failed sign-in is the
// same `401 unauthenticated`, with the same words (doc 02 section 2.3). Where verification is required, the
// correct password of an account whose address was never verified is the one other answer, `403
// email_unverified`; it is given only to someone who knows the password.

const REFUSED = "The email address or the password is wrong.";

export interface LoginRouteOptions extends SignInDependencies {
  readonly cookie: SessionCookieSpec;
}

export function loginRoute({ store, passwords, mail, registration, cookie }: LoginRouteOptions): RouteBinding {
  return route(login).handle(async ({ body }, context) => {
    const takeEmailLimit = context.get("takeEmailLimit");
    if (takeEmailLimit === undefined) {
      throw new Error("the login route was reached without the rate-limit stage that counts attempts per email");
    }
    await takeEmailLimit(context, await emailLimitKey(store, body.email));

    const header = context.req.raw.headers.get("cookie");
    const carried = header === null ? undefined : readCookie(header, cookie.name);
    const signedIn = await signIn(
      { store, passwords, mail, registration },
      {
        email: body.email,
        password: body.password,
        remember: body.remember,
        replacedTokenHash: carried === undefined ? null : (hashSessionToken(carried) ?? null),
        ipPrefix: networkPrefixOf(context.get("clientIp")) ?? null,
        userAgent: truncateUserAgent(context.req.raw.headers.get("user-agent")),
      },
    );
    if (signedIn === undefined) {
      throw new ProblemError("unauthenticated", REFUSED);
    }
    return { status: 200, headers: { "Set-Cookie": setSessionCookie(cookie, signedIn.token) }, body: { next: signedIn.next } };
  });
}
