import { sessionCookieSpec, type MailPort, type PasswordPolicy, type SecretBoxPort } from "@slugbase/core";
import type { AuthStore } from "@slugbase/db";
import { createApiTokenAuthenticator } from "../../auth/api-tokens.ts";
import { createSessionAuthenticator } from "../../auth/authenticator.ts";
import { createPasswordVerifier, hashPassword as hashArgon2id, verifyHash, type PasswordVerifier } from "../../auth/password.ts";
import type { ModuleContribution } from "../../create-server.ts";
import { securityRoutes } from "../me/security.ts";
import { sessionRoutes } from "../me/sessions.ts";
import { loginRoute } from "./login.ts";
import { logoutRoute } from "./logout.ts";
import { verifyMfaRoute } from "./mfa.ts";

export interface AuthRoutesOptions {
  readonly store: AuthStore;
  /** `APP_ORIGIN`: its scheme decides the name and flags of the session cookie. */
  readonly appOrigin: string;
  /** `SESSION_SECRET`: the list cursors are signed with a key derived from it. */
  readonly sessionSecret: string;
  /** The password policy a changed password is held to. */
  readonly passwordPolicy: PasswordPolicy;
  /** The mail port: a password change queues its email only when the port can send. */
  readonly mail: Pick<MailPort, "available">;
  /** Defaults to argon2id verification. */
  readonly passwords?: PasswordVerifier;
  /** Defaults to argon2id hashing. */
  readonly hashPassword?: (password: string) => Promise<string>;
  /** Opens the sealed TOTP secret a code is checked against. */
  readonly secretBox: Pick<SecretBoxPort, "open" | "needsRotation" | "reseal">;
  /** The instant a code is checked at, in milliseconds; defaults to the system clock. */
  readonly now?: () => number;
}

/**
 * What password sign-in contributes (doc 04 sections 10.2 and 10.3): the login
 * and logout routes, the routes that list and revoke the account's sessions,
 * the routes that re-authenticate and change the password, and the authenticators
 * that turn the session cookie and the bearer API token into a principal at stage
 * 4 of the chain.
 */
export function authContribution({
  store,
  appOrigin,
  sessionSecret,
  passwordPolicy,
  mail,
  passwords = createPasswordVerifier(),
  hashPassword = hashArgon2id,
  secretBox,
  now = Date.now,
}: AuthRoutesOptions): ModuleContribution {
  const cookie = sessionCookieSpec(appOrigin);
  return {
    routes: [loginRoute({ store, passwords, cookie }), verifyMfaRoute({ store, secretBox, verifyCode: verifyHash, now, cookie }), logoutRoute({ store, cookie }), ...sessionRoutes({ store, cookie, cursorSecret: sessionSecret }),
      ...securityRoutes({ store, passwords, passwordPolicy, hashPassword, cookie, mail, secretBox, verifyCode: verifyHash, now }),
    ],
    authenticators: [createSessionAuthenticator({ store, cookie }), createApiTokenAuthenticator({ store })],
  };
}
