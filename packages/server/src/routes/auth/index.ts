import { sessionCookieSpec } from "@slugbase/core";
import type { AuthStore } from "@slugbase/db";
import { createSessionAuthenticator } from "../../auth/authenticator.ts";
import { createPasswordVerifier, type PasswordVerifier } from "../../auth/password.ts";
import type { ModuleContribution } from "../../create-server.ts";
import { sessionRoutes } from "../me/sessions.ts";
import { loginRoute } from "./login.ts";
import { logoutRoute } from "./logout.ts";

export interface AuthRoutesOptions {
  readonly store: AuthStore;
  /** `APP_ORIGIN`: its scheme decides the name and flags of the session cookie. */
  readonly appOrigin: string;
  /** `SESSION_SECRET`: the list cursors are signed with a key derived from it. */
  readonly sessionSecret: string;
  /** Defaults to argon2id verification. */
  readonly passwords?: PasswordVerifier;
}

/**
 * What password sign-in contributes (doc 04 sections 10.2 and 10.3): the login
 * and logout routes, the routes that list and revoke the account's sessions,
 * and the authenticator that turns the session cookie into a principal at
 * stage 4 of the chain.
 */
export function authContribution({ store, appOrigin, sessionSecret, passwords = createPasswordVerifier() }: AuthRoutesOptions): ModuleContribution {
  const cookie = sessionCookieSpec(appOrigin);
  return {
    routes: [loginRoute({ store, passwords, cookie }), logoutRoute({ store, cookie }), ...sessionRoutes({ store, cookie, cursorSecret: sessionSecret })],
    authenticators: [createSessionAuthenticator({ store, cookie })],
  };
}
