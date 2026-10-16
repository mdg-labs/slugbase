import { changePassword as changePasswordOperation, reauthenticate as reauthenticateOperation } from "@slugbase/contracts";
import type { MailPort, PasswordPolicy, SecretBoxPort, SessionCookieSpec } from "@slugbase/core";
import type { AuthStore } from "@slugbase/db";
import { setSessionCookie } from "../../auth/cookie.ts";
import { reauthenticateWithCode } from "../../auth/mfa.ts";
import type { PasswordVerifier } from "../../auth/password.ts";
import { changePassword, reauthenticate } from "../../auth/reauth.ts";
import { uuidv7 } from "../../auth/uuidv7.ts";
import type { ChainContext, RouteBinding } from "../../http/chain.ts";
import { ProblemError } from "../../http/problem.ts";
import { queueMailSend } from "../../worker/jobs/mail-send.ts";
import { route } from "../register.ts";

// POST /api/v1/me/reauth and POST /api/v1/me/password (doc 04 sections 4.4 and
// 10.3, doc 10 T18). Re-authentication takes the password or, for an account
// whose second factor is on, a TOTP code; a wrong password is 401
// reauth_required and a wrong code 422 invalid_code, and the operation sits in
// the `mfa` bucket, which takes a token for every attempt of either kind.
// Neither operation answers with, or logs, a password, a code, a hash or a
// token: the only secret that leaves is the Set-Cookie of the rotated session.
// The password change declares `reauth`, so the authorization stage has refused
// a session that has not re-authenticated within ten minutes before this
// handler runs. A password change also queues the "password changed" email in the
// transaction that writes the change, so the message exists exactly when the change
// does and the request never waits for a delivery: whether the relay takes it is the
// worker's business, and the request answers either way. An instance that sends no
// mail (the log-only adapter) queues nothing.

const UNAUTHENTICATED = "Authentication is required.";
const WRONG_PASSWORD = "The password is wrong.";
const INVALID_CODE = "The code is wrong, has expired or was already used.";
const WRONG_CURRENT_PASSWORD = "The current password is wrong.";
const LENGTH_DETAIL = "The password must be 12 to 256 characters long.";
const BREACHED_DETAIL = "The password appears in a list of breached passwords. Choose a different one.";

export interface SecurityRoutesOptions {
  readonly store: Pick<
    AuthStore,
    "passwordHashOf" | "markReauthenticated" | "changePassword" | "mfaStateOf" | "resealMfaSecret" | "unusedBackupCodes" | "reauthenticateWithStep"
  >;
  readonly passwords: PasswordVerifier;
  /** Opens the sealed TOTP secret a code is checked against. */
  readonly secretBox: Pick<SecretBoxPort, "open" | "needsRotation" | "reseal">;
  /** Whether a backup code matches an argon2id PHC string. */
  readonly verifyCode: (hash: string, code: string) => Promise<boolean>;
  /** The instant a code is checked at, in milliseconds since the epoch. */
  readonly now: () => number;
  readonly passwordPolicy: PasswordPolicy;
  /** Hashes the new password into an argon2id PHC string. */
  readonly hashPassword: (password: string) => Promise<string>;
  readonly cookie: SessionCookieSpec;
  /** The mail port of the composition; a message is queued only when it can send. */
  readonly mail: Pick<MailPort, "available">;
}

function sessionOf(context: ChainContext): { readonly sessionId: string; readonly accountId: string } {
  const principal = context.get("principal");
  if (principal?.kind !== "session") {
    throw new ProblemError("unauthenticated", UNAUTHENTICATED);
  }
  return principal;
}

export function securityRoutes({ store, passwords, passwordPolicy, hashPassword, cookie, mail, secretBox, verifyCode, now }: SecurityRoutesOptions): RouteBinding[] {
  return [
    route(reauthenticateOperation).handle(async ({ body }, context) => {
      const { sessionId, accountId } = sessionOf(context);
      if ("code" in body) {
        const result = await reauthenticateWithCode({ store, secretBox, verifyCode, now }, { accountId, sessionId, code: body.code });
        if (result === "no_session") {
          throw new ProblemError("unauthenticated", UNAUTHENTICATED);
        }
        if (result === "invalid_code") {
          throw new ProblemError("invalid_code", INVALID_CODE, { errors: [{ path: "code", code: "invalid_code" }] });
        }
        return { status: 204 };
      }
      const outcome = await reauthenticate({ store, passwords }, { accountId, sessionId, password: body.password });
      if (outcome === "no_session") {
        throw new ProblemError("unauthenticated", UNAUTHENTICATED);
      }
      if (outcome === "wrong_password") {
        throw new ProblemError("reauth_required", WRONG_PASSWORD, { errors: [{ path: "password", code: "invalid_password" }] });
      }
      return { status: 204 };
    }),

    route(changePasswordOperation).handle(async ({ body }, context) => {
      const { sessionId, accountId } = sessionOf(context);
      const outcome = await changePassword(
        {
          store,
          passwords,
          passwordPolicy,
          hashPassword,
          jobsOnChange: (changed) => (mail.available ? [queueMailSend(uuidv7(), "passwordChanged", changed)] : []),
        },
        { accountId, sessionId, ...(body.currentPassword === undefined ? {} : { currentPassword: body.currentPassword }), newPassword: body.newPassword },
      );
      switch (outcome.kind) {
        case "changed":
          return { status: 204, headers: { "Set-Cookie": setSessionCookie(cookie, outcome.token) } };
        case "weak_password":
          throw new ProblemError("weak_password", outcome.problems.includes("breached") ? BREACHED_DETAIL : LENGTH_DETAIL, {
            errors: outcome.problems.map((code) => ({ path: "newPassword", code })),
          });
        case "wrong_password":
          throw new ProblemError("validation_failed", WRONG_CURRENT_PASSWORD, { errors: [{ path: "currentPassword", code: "invalid_password" }] });
        case "no_session":
          throw new ProblemError("unauthenticated", UNAUTHENTICATED);
      }
    }),
  ];
}
