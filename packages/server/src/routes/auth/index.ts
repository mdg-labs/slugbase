import { sessionCookieSpec } from "@slugbase/core";
import type { AuthStore } from "@slugbase/db";
import { createSessionAuthenticator } from "../../auth/authenticator.ts";
import { createPasswordVerifier, type PasswordVerifier } from "../../auth/password.ts";
import type { ModuleContribution } from "../../create-server.ts";
import { loginRoute } from "./login.ts";
import { logoutRoute } from "./logout.ts";

export interface AuthRoutesOptions {
  readonly store: AuthStore;
  /** `APP_ORIGIN`: its scheme decides the name and flags of the session cookie. */
  readonly appOrigin: string;
  /** Defaults to argon2id verification. */
  readonly passwords?: PasswordVerifier;
}

/**
 * What password sign-in contributes (doc 04 section 10.2): the login and logout
 * routes and the authenticator that turns the session cookie into a principal
 * at stage 4 of the chain.
 */
export function authContribution({ store, appOrigin, passwords = createPasswordVerifier() }: AuthRoutesOptions): ModuleContribution {
  const cookie = sessionCookieSpec(appOrigin);
  return {
    routes: [loginRoute({ store, passwords, cookie }), logoutRoute({ store, cookie })],
    authenticators: [createSessionAuthenticator({ store, cookie })],
  };
}
