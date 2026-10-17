import { sessionCookieSpec, type IdentityPort, type MailPort, type PasswordPolicy, type RegistrationSettings, type SecretBoxPort } from "@slugbase/core";
import type { AuthStore } from "@slugbase/db";
import { createApiTokenAuthenticator } from "../../auth/api-tokens.ts";
import { createSessionAuthenticator } from "../../auth/authenticator.ts";
import { createPasswordVerifier, hashPassword as hashArgon2id, verifyHash, type PasswordVerifier } from "../../auth/password.ts";
import type { ModuleContribution } from "../../create-server.ts";
import { securityRoutes } from "../me/security.ts";
import { sessionRoutes } from "../me/sessions.ts";
import { loginRoute } from "./login.ts";
import { logoutRoute } from "./logout.ts";
import { oidcRoutes } from "./oidc.ts";
import { registerRoute } from "./register.ts";
import { verifyMfaRoute } from "./mfa.ts";
import { resendVerificationRoute } from "./resend-verification.ts";
import { verifyEmailRoute } from "./verify-email.ts";

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
  /** The settings in force for public registration. */
  readonly registration: RegistrationSettings;
  /** Defaults to argon2id verification. */
  readonly passwords?: PasswordVerifier;
  /** Defaults to argon2id hashing. */
  readonly hashPassword?: (password: string) => Promise<string>;
  /** Seals the PKCE verifier of an OIDC handshake and opens the sealed TOTP secret a code is checked against. */
  readonly secretBox: Pick<SecretBoxPort, "seal" | "open" | "needsRotation" | "reseal">;
  /** The OIDC providers of the operator: the sign-in routes answer a failed handshake alike when there are none. */
  readonly identity: Pick<IdentityPort, "begin" | "complete">;
  /** The instant a code is checked at, in milliseconds; defaults to the system clock. */
  readonly now?: () => number;
}

/**
 * What sign-in contributes (doc 04 sections 10.2 and 10.3): the login,
 * registration, email verification (and the resend of its link) and logout routes, the start and callback of OIDC sign-in, the routes that list and revoke the account's sessions,
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
  registration,
  passwords = createPasswordVerifier(),
  hashPassword = hashArgon2id,
  secretBox,
  identity,
  now = Date.now,
}: AuthRoutesOptions): ModuleContribution {
  const cookie = sessionCookieSpec(appOrigin);
  return {
    routes: [loginRoute({ store, passwords, mail, registration, cookie }), registerRoute({ store, settings: registration, mail, passwordPolicy, hashPassword }), verifyEmailRoute({ store, passwordPolicy, hashPassword, cookie }), resendVerificationRoute({ store, mail }), ...oidcRoutes({ store, identity, secretBox, appOrigin, sessionSecret, sessionCookie: cookie, now }), verifyMfaRoute({ store, mail, secretBox, verifyCode: verifyHash, now, cookie }), logoutRoute({ store, cookie }), ...sessionRoutes({ store, cookie, cursorSecret: sessionSecret }),
      ...securityRoutes({ store, passwords, passwordPolicy, hashPassword, cookie, mail, secretBox, verifyCode: verifyHash, now }),
    ],
    authenticators: [createSessionAuthenticator({ store, cookie }), createApiTokenAuthenticator({ store })],
  };
}
