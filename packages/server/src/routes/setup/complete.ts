import { completeSetup, type SetupRequestSchema } from "@slugbase/contracts";
import { normalizeEmail, prepareAuditRecord, truncateUserAgent, type PasswordPolicy, type SessionCookieSpec } from "@slugbase/core";
import type { SetupStore } from "@slugbase/db";
import type { z } from "zod";
import { setSessionCookie } from "../../auth/cookie.ts";
import { newSessionToken } from "../../auth/session-token.ts";
import { hashSetupToken } from "../../auth/setup-token.ts";
import { uuidv7 } from "../../auth/uuidv7.ts";
import type { ServerConfig } from "../../config/index.ts";
import { queueDomainEvent } from "../../events/publish.ts";
import type { RouteBinding } from "../../http/chain.ts";
import { ProblemError, type ProblemFieldError } from "../../http/problem.ts";
import { networkPrefixOf } from "../../http/trusted-proxy.ts";
import { route } from "../register.ts";
import { setupRequired } from "./status.ts";

// POST /api/v1/setup (doc 04 section 10.2, doc 02 section 2.2, doc 10 section
// 2.1): creates the first account, as instance admin, with its workspace, and
// signs it in. The check that it happens once is the database's
// (`sys_complete_setup` takes an advisory lock and re-checks under it); the
// check here only spares a closed instance the cost of hashing a password. The
// `account.created` and `workspace.created` events are queued, and the workspace's
// `workspace.created` audit event is written, in the setup's own transaction (doc 01
// section 7.1 and 8.1, doc 05 section 2.9), so they exist exactly when the account and
// the workspace do; setup skips the registration policy (doc 01 section 13.5) but
// announces its account and workspace like any other.

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
  /** The password policy every password-setting flow goes through. */
  readonly passwordPolicy: PasswordPolicy;
}

type SetupRequest = z.output<typeof SetupRequestSchema>;

const LENGTH_DETAIL = "The password must be 12 to 256 characters long.";
const BREACHED_DETAIL = "The password appears in a list of breached passwords. Choose a different one.";

/** The field errors of a request the schema accepted but that cannot be written: a blank workspace name, or a password the policy refuses. */
function refusals(body: SetupRequest, workspaceName: string, policy: PasswordPolicy): ProblemFieldError[] {
  const errors: ProblemFieldError[] = [];
  if (workspaceName === "") {
    errors.push({ path: "workspaceName", code: "too_small" });
  }
  for (const code of policy.check(body.password)) {
    errors.push({ path: "password", code });
  }
  return errors;
}

export function completeSetupRoute({ config, store, hashPassword, cookie, passwordPolicy }: CompleteSetupRouteOptions): RouteBinding {
  return route(completeSetup).handle(async ({ body }, context) => {
    if (!(await setupRequired({ config, store }))) {
      throw new ProblemError("setup_completed", CLOSED);
    }

    const workspaceName = body.workspaceName.trim();
    const errors = refusals(body, workspaceName, passwordPolicy);
    if (errors.length > 0) {
      const weak = errors.every((error) => error.path === "password");
      const detail = errors.some((error) => error.code === "breached") ? BREACHED_DETAIL : LENGTH_DETAIL;
      throw weak
        ? new ProblemError("weak_password", detail, { errors })
        : new ProblemError("validation_failed", "The request did not pass validation.", { errors });
    }

    const token = newSessionToken();
    const workspaceId = uuidv7();
    const accountId = uuidv7();
    const ipPrefix = networkPrefixOf(context.get("clientIp")) ?? null;
    const outcome = await store.completeSetup({
      accountId,
      workspaceId,
      sessionId: uuidv7(),
      email: normalizeEmail(body.email),
      displayName: body.displayName,
      passwordHash: await hashPassword(body.password),
      locale: FIRST_LOCALE,
      workspaceName,
      tokenRequired: config.SETUP_TOKEN_REQUIRED,
      tokenHash: body.setupToken === undefined ? null : hashSetupToken(body.setupToken),
      sessionTokenHash: token.hash,
      ipPrefix,
      userAgent: truncateUserAgent(context.req.raw.headers.get("user-agent")),
      jobs: [
        queueDomainEvent(uuidv7(), "account.created", { accountId, path: "setup" }),
        queueDomainEvent(uuidv7(), "workspace.created", { workspaceId, accountId }),
      ],
      audit: [
        prepareAuditRecord(
          {
            action: "workspace.created",
            workspaceId,
            actor: { type: "account", accountId, label: body.displayName },
            entity: { type: "workspace", id: workspaceId },
            metadata: { name: workspaceName },
            ipPrefix,
          },
          uuidv7,
        ),
      ],
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
