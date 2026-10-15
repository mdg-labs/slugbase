import { verifyMfa } from "@slugbase/contracts";
import type { SessionCookieSpec } from "@slugbase/core";
import { setSessionCookie } from "../../auth/cookie.ts";
import { verifySecondFactor, type SecondFactorDependencies } from "../../auth/mfa.ts";
import type { RouteBinding } from "../../http/chain.ts";
import { ProblemError } from "../../http/problem.ts";
import { route } from "../register.ts";

// POST /api/v1/auth/mfa/verify (doc 04 sections 4.3 and 10.2, doc 02 section
// 2.3, doc 10 T17). The operation declares the `partial` policy, so stage 9
// lets a session in whose second factor is still pending as well as a complete
// one; only the pending one has anything to complete. The account and the
// session are the principal's, never a value of the request, and a code, a
// backup code and a secret appear in no problem document and no log line.

const UNAUTHENTICATED = "Authentication is required.";
const NOT_WAITING = "This session is not waiting for a second factor.";
const INVALID_CODE = "The code is wrong, has expired or was already used.";

export interface VerifyMfaRouteOptions extends SecondFactorDependencies {
  readonly cookie: SessionCookieSpec;
}

export function verifyMfaRoute({ cookie, ...dependencies }: VerifyMfaRouteOptions): RouteBinding {
  return route(verifyMfa).handle(async ({ body }, context) => {
    const principal = context.get("principal");
    if (principal?.kind !== "session") {
      throw new ProblemError("unauthenticated", UNAUTHENTICATED);
    }
    if (principal.mfaPending !== true) {
      throw new ProblemError("validation_failed", NOT_WAITING);
    }
    const outcome = await verifySecondFactor(dependencies, {
      accountId: principal.accountId,
      sessionId: principal.sessionId,
      given: "code" in body ? { kind: "code", code: body.code } : { kind: "backup", code: body.backupCode },
    });
    switch (outcome.kind) {
      case "signed_in":
        return { status: 200, headers: { "Set-Cookie": setSessionCookie(cookie, outcome.token) }, body: { next: "done" } };
      case "invalid_code":
        throw new ProblemError("invalid_code", INVALID_CODE);
      case "no_session":
        throw new ProblemError("unauthenticated", UNAUTHENTICATED);
    }
  });
}
