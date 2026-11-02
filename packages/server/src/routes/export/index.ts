import { exportJson as exportJsonOperation } from "@slugbase/contracts";
import { createAuditWriter, exportFilename, exportStream, startExport, type AuditActor } from "@slugbase/core";
import { accountProfileRepository, auditEventRepository, exportRepository } from "@slugbase/db";
import { uuidv7 } from "../../auth/uuidv7.ts";
import type { Logger } from "../../create-server.ts";
import type { ChainContext, RouteBinding } from "../../http/chain.ts";
import { ProblemError, requestIdOf } from "../../http/problem.ts";
import type { RequestTenant } from "../../http/tenant.ts";
import { networkPrefixOf } from "../../http/trusted-proxy.ts";
import { route } from "../register.ts";

// GET /api/v1/export/json (doc 04 section 10.9, doc 02 sections 13.2 and 13.3, doc 10 T1 and T2). It acts in the workspace the request is bound to and names none; the authorization stage lets a
// member through by a session or by an API token of the read scope, and the request is in the `bulk` rate bucket. One transaction counts what the caller owns and records it as one `export.created`
// audit event, with the account or the token as the actor, before the first byte; a failure of either ends the request with an error and no file is started. The document is then streamed
// from the repository's pages, each in a transaction of its own that is over before the page is sent (core's `exportStream`), so the server holds one page of an export whatever its size and no
// transaction waits on a slow client; nothing is stored. A page that cannot be read ends the connection with the document unfinished, so what was received does not parse. Every read names the
// account of the request as the owner (src/repositories/export.ts), so another member's content, content with no owner and anything of another workspace is in no answer.

const NO_WORKSPACE = "No such resource.";

function tenantOf(context: ChainContext): RequestTenant {
  const tenant = context.get("tenant");
  if (tenant === undefined) {
    throw new ProblemError("not_found", NO_WORKSPACE);
  }
  return tenant;
}

/** Who the audit log names for an export: the token when a bearer token made the request, the account otherwise. */
function auditActorOf(context: ChainContext, accountId: string, label: string): AuditActor {
  const principal = context.get("principal");
  return principal?.kind === "api-token" ? { type: "api_token", accountId, tokenId: principal.tokenId, label } : { type: "account", accountId, label };
}

export interface ExportRoutesOptions {
  /** Told of a page that could not be read after the first byte was sent. */
  readonly logger: Logger;
}

export function exportRoutes({ logger }: ExportRoutesOptions): RouteBinding[] {
  return [
    route(exportJsonOperation).handle(async (_request, context) => {
      const tenant = tenantOf(context);
      const ipPrefix = networkPrefixOf(context.get("clientIp")) ?? null;
      const exportedAt = new Date();
      const started = await tenant.withTenant(async (tx) => {
        const profile = await accountProfileRepository(tx).profile();
        if (profile === undefined) {
          return { kind: "unavailable" } as const;
        }
        return startExport(
          { store: exportRepository(tx), audit: createAuditWriter({ store: auditEventRepository(tx), newId: uuidv7 }) },
          { workspaceId: tenant.workspaceId, accountId: tenant.accountId, actor: auditActorOf(context, tenant.accountId, profile.displayName), ipPrefix },
        );
      });
      if (started.kind === "unavailable") {
        throw new ProblemError("not_found", NO_WORKSPACE);
      }
      const requestId = requestIdOf(context);
      const body = exportStream(
        {
          page: (read) => tenant.withTenant((tx) => read(exportRepository(tx))),
          onFailure: (error) => {
            logger.error("An export ended before its last byte", {
              requestId,
              error: error instanceof Error ? error.name : typeof error,
              code: (error as { code?: unknown } | null)?.code,
            });
          },
        },
        { accountId: tenant.accountId, workspaceName: started.summary.workspaceName, exportedAt },
      );
      return { status: 200, body, headers: { "Content-Disposition": `attachment; filename="${exportFilename(exportedAt)}"` } };
    }),
  ];
}
