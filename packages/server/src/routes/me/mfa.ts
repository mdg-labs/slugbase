import {
  confirmMfaEnrollment as confirmMfaEnrollmentOperation,
  disableMfa as disableMfaOperation,
  regenerateMfaBackupCodes as regenerateMfaBackupCodesOperation,
  startMfaEnrollment as startMfaEnrollmentOperation,
} from "@slugbase/contracts";
import type { MailPort, SessionCookieSpec } from "@slugbase/core";
import { accountProfileRepository, type Database } from "@slugbase/db";
import { setSessionCookie } from "../../auth/cookie.ts";
import { confirmEnrollment, disableMfa, regenerateBackupCodes, startEnrollment, type ManagementDependencies, type MfaDependencies } from "../../auth/mfa.ts";
import { uuidv7 } from "../../auth/uuidv7.ts";
import type { ChainContext, RouteBinding } from "../../http/chain.ts";
import { ProblemError, requestIdOf } from "../../http/problem.ts";
import { queueMailSend } from "../../worker/jobs/mail-send.ts";
import { route } from "../register.ts";

// POST /api/v1/me/mfa/enrollment, POST /api/v1/me/mfa/enrollment/confirm,
// POST /api/v1/me/mfa/backup-codes and DELETE /api/v1/me/mfa (doc 04 section
// 10.3, doc 02 section 2.7, doc 10 T7 and T17). Starting an enrolment,
// regenerating the backup codes and disabling the factor declare `reauth`, so
// the authorization stage has refused a session that has not re-authenticated
// within ten minutes before the handler runs; regenerating and disabling also
// need the second factor, and every operation that takes a code is limited by
// the `mfa` bucket, which takes a token for every attempt, a wrong code
// included. The account is always the session's, never a value of the request.
// Only the start response carries the secret and only the confirm and
// regenerate responses carry backup codes; none is logged, and a problem
// document is built from fixed text. Enabling and disabling the factor also
// queue the "MFA enabled" and "MFA disabled" emails in the transaction that
// writes the change, when the composition's mail can send (doc 02 section 12).

const UNAUTHENTICATED = "Authentication is required.";
const ALREADY_ENABLED = "Two-factor authentication is already on.";
const NO_ENROLMENT = "There is no authenticator enrolment to confirm. Start one first.";
const INVALID_CODE = "The code is wrong or has expired.";
const NOT_ENABLED = "Two-factor authentication is not on.";
const WRONG_PASSWORD = "The password is wrong.";

export interface MfaRoutesOptions
  extends Omit<MfaDependencies, "store" | "jobsOnEnable">,
    Omit<ManagementDependencies, "store" | "secretBox" | "jobsOnDisable"> {
  readonly store: MfaDependencies["store"] & ManagementDependencies["store"];
  readonly withTenant: Database["withTenant"];
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

export function mfaRoutes({ withTenant, cookie, mail, ...options }: MfaRoutesOptions): RouteBinding[] {
  // Turning the factor on or off queues its email in the transaction that writes the change; mail that cannot send queues nothing.
  const dependencies = {
    ...options,
    jobsOnEnable: (accountId: string) => (mail.available ? [queueMailSend(uuidv7(), "mfaEnabled", accountId)] : []),
    jobsOnDisable: (accountId: string) => (mail.available ? [queueMailSend(uuidv7(), "mfaDisabled", accountId)] : []),
  };
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

    route(regenerateMfaBackupCodesOperation).handle(async ({ body }, context) => {
      const { accountId } = sessionOf(context);
      const outcome = await regenerateBackupCodes(dependencies, { accountId, code: body.code });
      switch (outcome.kind) {
        case "regenerated":
          return { status: 200, body: { backupCodes: [...outcome.backupCodes] } };
        case "invalid_code":
          throw new ProblemError("invalid_code", INVALID_CODE, { errors: [{ path: "code", code: "invalid_code" }] });
        case "not_enabled":
          throw new ProblemError("validation_failed", NOT_ENABLED);
      }
    }),

    route(disableMfaOperation).handle(async ({ body }, context) => {
      const { sessionId, accountId } = sessionOf(context);
      const given = "code" in body ? ({ kind: "code", code: body.code } as const) : ({ kind: "backup", code: body.backupCode } as const);
      const outcome = await disableMfa(dependencies, { accountId, sessionId, ...(body.password === undefined ? {} : { password: body.password }), given });
      switch (outcome.kind) {
        case "disabled":
          return { status: 204, headers: { "Set-Cookie": setSessionCookie(cookie, outcome.token) } };
        case "wrong_password":
          throw new ProblemError("validation_failed", WRONG_PASSWORD, { errors: [{ path: "password", code: "invalid_password" }] });
        case "invalid_code": {
          const path = given.kind === "code" ? "code" : "backupCode";
          throw new ProblemError("invalid_code", INVALID_CODE, { errors: [{ path, code: "invalid_code" }] });
        }
        case "not_enabled":
          throw new ProblemError("validation_failed", NOT_ENABLED);
        case "no_session":
          throw new ProblemError("unauthenticated", UNAUTHENTICATED);
      }
    }),
  ];
}
