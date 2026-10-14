import { changePassword as changePasswordOperation, reauthenticate as reauthenticateOperation } from "@slugbase/contracts";
import type { PasswordPolicy, SessionCookieSpec } from "@slugbase/core";
import type { AuthStore } from "@slugbase/db";
import { setSessionCookie } from "../../auth/cookie.ts";
import type { PasswordVerifier } from "../../auth/password.ts";
import { changePassword, reauthenticate } from "../../auth/reauth.ts";
import type { ChainContext, RouteBinding } from "../../http/chain.ts";
import { ProblemError } from "../../http/problem.ts";
import { route } from "../register.ts";

// POST /api/v1/me/reauth and POST /api/v1/me/password (doc 04 sections 4.4 and
// 10.3, doc 10 T18). Neither answers with, or logs, a password, a hash or a
// token: the only secret that leaves is the Set-Cookie of the rotated session.
// The password change declares `reauth`, so the authorization stage has refused
// a session that has not re-authenticated within ten minutes before this
// handler runs.

const UNAUTHENTICATED = "Authentication is required.";
const WRONG_PASSWORD = "The password is wrong.";
const WRONG_CURRENT_PASSWORD = "The current password is wrong.";
const LENGTH_DETAIL = "The password must be 12 to 256 characters long.";
const BREACHED_DETAIL = "The password appears in a list of breached passwords. Choose a different one.";

export interface SecurityRoutesOptions {
  readonly store: Pick<AuthStore, "passwordHashOf" | "markReauthenticated" | "changePassword">;
  readonly passwords: PasswordVerifier;
  readonly passwordPolicy: PasswordPolicy;
  /** Hashes the new password into an argon2id PHC string. */
  readonly hashPassword: (password: string) => Promise<string>;
  readonly cookie: SessionCookieSpec;
}

function sessionOf(context: ChainContext): { readonly sessionId: string; readonly accountId: string } {
  const principal = context.get("principal");
  if (principal?.kind !== "session") {
    throw new ProblemError("unauthenticated", UNAUTHENTICATED);
  }
  return principal;
}

export function securityRoutes({ store, passwords, passwordPolicy, hashPassword, cookie }: SecurityRoutesOptions): RouteBinding[] {
  return [
    route(reauthenticateOperation).handle(async ({ body }, context) => {
      const { sessionId, accountId } = sessionOf(context);
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
        { store, passwords, passwordPolicy, hashPassword },
        { accountId, sessionId, currentPassword: body.currentPassword, newPassword: body.newPassword },
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
