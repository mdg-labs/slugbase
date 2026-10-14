import { completeSetup, type SetupRequestSchema } from "@slugbase/contracts";
import { normalizeEmail, passwordLengthProblem, truncateUserAgent, type SessionCookieSpec } from "@slugbase/core";
import type { SetupStore } from "@slugbase/db";
import type { z } from "zod";
import { setSessionCookie } from "../../auth/cookie.ts";
import { newSessionToken } from "../../auth/session-token.ts";
import { hashSetupToken } from "../../auth/setup-token.ts";
import { uuidv7 } from "../../auth/uuidv7.ts";
import type { ServerConfig } from "../../config/index.ts";
import type { RouteBinding } from "../../http/chain.ts";
import { ProblemError, type ProblemFieldError } from "../../http/problem.ts";
import { networkPrefixOf } from "../../http/trusted-proxy.ts";
import { route } from "../register.ts";
import { setupRequired } from "./status.ts";

// POST /api/v1/setup (doc 04 section 10.2, doc 02 section 2.2, doc 10 section
// 2.1): creates the first account, as instance admin, with its workspace, and
// signs it in. The check that it happens once is the database's
// (`sys_complete_setup` takes an advisory lock and re-checks under it); the
// check here only spares a closed instance the cost of hashing a password.

const CLOSED = "First-run setup is completed or turned off.";
const WRONG_TOKEN = "The setup token is missing or wrong.";

/** The locale of the first account; it can change it in its settings. */
const FIRST_LOCALE = "en";

export interface CompleteSetupRouteOptions {
  readonly config: Pick<ServerConfig, "SETUP_ENABLED" | "SETUP_TOKEN_REQUIRED">;
  readonly store: Pick<SetupStore, "setupPending" | "completeSetup">;
  /** Hashes the password into an argon2id PHC string. */
  readonly hashPassword: (password: string) => Promise<string>;
  readonly cookie: SessionCookieSpec;
}

type SetupRequest = z.output<typeof SetupRequestSchema>;

/** The field errors of a request the schema accepted but that cannot be written: a blank name, or a password outside its length. */
function refusals(body: SetupRequest, displayName: string, workspaceName: string): ProblemFieldError[] {
  const errors: ProblemFieldError[] = [];
  if (displayName === "") {
    errors.push({ path: "displayName", code: "too_small" });
  }
  if (workspaceName === "") {
    errors.push({ path: "workspaceName", code: "too_small" });
  }
  const password = passwordLengthProblem(body.password);
  if (password !== undefined) {
    errors.push({ path: "password", code: password });
  }
  return errors;
}

export function completeSetupRoute({ config, store, hashPassword, cookie }: CompleteSetupRouteOptions): RouteBinding {
  return route(completeSetup).handle(async ({ body }, context) => {
    if (!(await setupRequired({ config, store }))) {
      throw new ProblemError("setup_completed", CLOSED);
    }

    const displayName = body.displayName.trim();
    const workspaceName = body.workspaceName.trim();
    const errors = refusals(body, displayName, workspaceName);
    if (errors.length > 0) {
      const weak = errors.every((error) => error.path === "password");
      throw weak
        ? new ProblemError("weak_password", "The password must be 12 to 256 characters long.", { errors })
        : new ProblemError("validation_failed", "The request did not pass validation.", { errors });
    }

    const token = newSessionToken();
    const workspaceId = uuidv7();
    const outcome = await store.completeSetup({
      accountId: uuidv7(),
      workspaceId,
      sessionId: uuidv7(),
      email: normalizeEmail(body.email),
      displayName,
      passwordHash: await hashPassword(body.password),
      locale: FIRST_LOCALE,
      workspaceName,
      tokenRequired: config.SETUP_TOKEN_REQUIRED,
      tokenHash: body.setupToken === undefined ? null : hashSetupToken(body.setupToken),
      sessionTokenHash: token.hash,
      ipPrefix: networkPrefixOf(context.get("clientIp")) ?? null,
      userAgent: truncateUserAgent(context.req.raw.headers.get("user-agent")),
    });
    if (outcome === "setup_completed") {
      throw new ProblemError("setup_completed", CLOSED);
    }
    if (outcome === "forbidden") {
      throw new ProblemError("forbidden", WRONG_TOKEN);
    }
    return { status: 201, headers: { "Set-Cookie": setSessionCookie(cookie, token.value) }, body: { workspaceId } };
  });
}
