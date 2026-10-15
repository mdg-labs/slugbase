import { confirmMfaEnrollment as confirmMfaEnrollmentOperation, startMfaEnrollment as startMfaEnrollmentOperation } from "@slugbase/contracts";
import type { SessionCookieSpec } from "@slugbase/core";
import { accountProfileRepository, type Database } from "@slugbase/db";
import { setSessionCookie } from "../../auth/cookie.ts";
import { confirmEnrollment, startEnrollment, type MfaDependencies } from "../../auth/mfa.ts";
import type { ChainContext, RouteBinding } from "../../http/chain.ts";
import { ProblemError, requestIdOf } from "../../http/problem.ts";
import { route } from "../register.ts";

// POST /api/v1/me/mfa/enrollment and POST /api/v1/me/mfa/enrollment/confirm
// (doc 04 section 10.3, doc 02 section 2.7, doc 10 T7). Starting an enrolment
// declares `reauth`, so the authorization stage has refused a session that has
// not re-authenticated within ten minutes before the handler runs; confirming
// is limited by the `mfa` bucket, which takes a token for every attempt, a
// wrong code included. The account is always the session's, never a value of
// the request. Only the start response carries the secret and only the confirm
// response carries the backup codes; neither is logged, and a problem document
// is built from fixed text.

const UNAUTHENTICATED = "Authentication is required.";
const ALREADY_ENABLED = "Two-factor authentication is already on.";
const NO_ENROLMENT = "There is no authenticator enrolment to confirm. Start one first.";
const INVALID_CODE = "The code is wrong or has expired.";

export interface MfaRoutesOptions extends MfaDependencies {
  readonly withTenant: Database["withTenant"];
  readonly cookie: SessionCookieSpec;
}

function sessionOf(context: ChainContext): { readonly sessionId: string; readonly accountId: string } {
  const principal = context.get("principal");
  if (principal?.kind !== "session") {
    throw new ProblemError("unauthenticated", UNAUTHENTICATED);
  }
  return principal;
}

export function mfaRoutes({ withTenant, cookie, ...dependencies }: MfaRoutesOptions): RouteBinding[] {
  return [
    route(startMfaEnrollmentOperation).handle(async (_request, context) => {
      const { accountId } = sessionOf(context);
      const profile = await withTenant({ accountId, requestId: requestIdOf(context) }, (tx) => accountProfileRepository(tx).profile());
      if (profile === undefined) {
        throw new ProblemError("unauthenticated", UNAUTHENTICATED);
      }
      const outcome = await startEnrollment(dependencies, { accountId, email: profile.email });
      if (outcome.kind === "already_enabled") {
        throw new ProblemError("validation_failed", ALREADY_ENABLED);
      }
      return { status: 200, body: { secret: outcome.secret, otpauthUri: outcome.otpauthUri, qrSvg: outcome.qrSvg } };
    }),

    route(confirmMfaEnrollmentOperation).handle(async ({ body }, context) => {
      const { sessionId, accountId } = sessionOf(context);
      const outcome = await confirmEnrollment(dependencies, { accountId, sessionId, code: body.code });
      switch (outcome.kind) {
        case "enabled":
          return { status: 200, body: { backupCodes: [...outcome.backupCodes] }, headers: { "Set-Cookie": setSessionCookie(cookie, outcome.token) } };
        case "invalid_code":
          throw new ProblemError("invalid_code", INVALID_CODE, { errors: [{ path: "code", code: "invalid_code" }] });
        case "no_enrolment":
          throw new ProblemError("validation_failed", NO_ENROLMENT);
        case "no_session":
          throw new ProblemError("unauthenticated", UNAUTHENTICATED);
      }
    }),
  ];
}
