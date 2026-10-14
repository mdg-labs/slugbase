import { login } from "@slugbase/contracts";
import { normalizeEmail, truncateUserAgent, type SessionCookieSpec } from "@slugbase/core";
import type { AuthStore } from "@slugbase/db";
import { createHash } from "node:crypto";
import { readCookie, setSessionCookie } from "../../auth/cookie.ts";
import { signIn, type SignInDependencies } from "../../auth/login.ts";
import { hashSessionToken } from "../../auth/session-token.ts";
import type { RouteBinding } from "../../http/chain.ts";
import { ProblemError } from "../../http/problem.ts";
import { networkPrefixOf } from "../../http/trusted-proxy.ts";
import { route } from "../register.ts";

// POST /api/v1/auth/login (doc 04 section 10.2). Every failed sign-in is the
// same `401 unauthenticated`, with the same words (doc 02 section 2.3).

const REFUSED = "The email address or the password is wrong.";

export interface LoginRouteOptions extends SignInDependencies {
  readonly cookie: SessionCookieSpec;
}

/**
 * What the per-address limit counts under: the address folded by the database, as the account lookup
 * compares it, so every spelling of one account shares one bucket; hashed so the bucket table never
 * holds an email.
 */
async function limitKey(store: AuthStore, email: string): Promise<string> {
  return createHash("sha256")
    .update(await store.emailKey(normalizeEmail(email)))
    .digest("hex");
}

export function loginRoute({ store, passwords, cookie }: LoginRouteOptions): RouteBinding {
  return route(login).handle(async ({ body }, context) => {
    const takeEmailLimit = context.get("takeEmailLimit");
    if (takeEmailLimit === undefined) {
      throw new Error("the login route was reached without the rate-limit stage that counts attempts per email");
    }
    await takeEmailLimit(context, await limitKey(store, body.email));

    const header = context.req.raw.headers.get("cookie");
    const carried = header === null ? undefined : readCookie(header, cookie.name);
    const signedIn = await signIn(
      { store, passwords },
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
    return { status: 200, headers: { "Set-Cookie": setSessionCookie(cookie, signedIn.token) }, body: { next: "done" } };
  });
}
