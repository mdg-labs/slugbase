import { exportJson as exportJsonOperation, EXPORT_NETSCAPE_CONTENT_TYPE, exportNetscape as exportNetscapeOperation } from "@slugbase/contracts";
import { createAuditWriter, exportFilename, exportNetscapeFilename, exportNetscapeStream, exportStream, startExport, type AuditActor, type ExportSummary } from "@slugbase/core";
import { accountProfileRepository, auditEventRepository, exportRepository } from "@slugbase/db";
import { uuidv7 } from "../../auth/uuidv7.ts";
import type { Logger } from "../../create-server.ts";
import type { ChainContext, RouteBinding } from "../../http/chain.ts";
import { ProblemError, requestIdOf } from "../../http/problem.ts";
import type { RequestTenant } from "../../http/tenant.ts";
import { networkPrefixOf } from "../../http/trusted-proxy.ts";
import { route } from "../register.ts";

// GET /api/v1/export/json and GET /api/v1/export/netscape (doc 04 section 10.9, doc 02 sections 13.2 and 13.3, doc 10 T1 and T2). It acts in the workspace the request is bound to and names none; the authorization stage lets a
// member through by a session or by an API token of the read scope, and the request is in the `bulk` rate bucket. One transaction counts what the caller owns and records it as one `export.created`
// audit event, with the account or the token as the actor, before the first byte; a failure of either ends the request with an error and no file is started. The document is then streamed
// from the repository's pages, each in a transaction of its own that is over before the page is sent (core's `exportStream`), so the server holds one page of an export whatever its size and no
// transaction waits on a slow client; nothing is stored. A page that cannot be read ends the connection with the document unfinished, so what was received does not parse. Every read names the
// account of the request as the owner (src/repositories/export.ts), so another member's content, content with no owner and anything of another workspace is in no answer. The Netscape file is the same
// export in the other format: it starts the same way (one `export.created`, counts only, before the first byte) and is streamed the same way, and it is answered as `text/html; charset=utf-8` with the
// disposition of an attachment, which with the `nosniff` of every response means a navigation to it downloads the file and never renders it in the origin of the application (doc 10 T14).
//
// `includeShared=true` (doc 02 section 13.2) adds the bookmarks other members shared with the caller, in the `shared` list of the document and at the top level of the file. They are read by the same
// repository, for the account of the request, page by page and under the grants as they stand when each page is read (src/repositories/export.ts), and the count the event records is the number of them
// that the caller could read when the export began. Without the parameter, or with `includeShared=false`, nothing shared is read, the list is empty and the event counts none.

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

/** Counts what the caller owns and records the export, in one transaction; undefined when the workspace cannot be read, which ends the request. */
async function begin(context: ChainContext, tenant: RequestTenant, includeShared: boolean): Promise<ExportSummary | undefined> {
  const ipPrefix = networkPrefixOf(context.get("clientIp")) ?? null;
  const started = await tenant.withTenant(async (tx) => {
    const profile = await accountProfileRepository(tx).profile();
    if (profile === undefined) {
      return { kind: "unavailable" } as const;
    }
    return startExport(
      { store: exportRepository(tx), audit: createAuditWriter({ store: auditEventRepository(tx), newId: uuidv7 }) },
      { workspaceId: tenant.workspaceId, accountId: tenant.accountId, actor: auditActorOf(context, tenant.accountId, profile.displayName), ipPrefix, includeShared },
    );
  });
  return started.kind === "unavailable" ? undefined : started.summary;
}

export function exportRoutes({ logger }: ExportRoutesOptions): RouteBinding[] {
  const onFailure = (context: ChainContext) => {
    const requestId = requestIdOf(context);
    return (error: unknown): void => {
      logger.error("An export ended before its last byte", {
        requestId,
        error: error instanceof Error ? error.name : typeof error,
        code: (error as { code?: unknown } | null)?.code,
      });
    };
  };

  return [
    route(exportJsonOperation).handle(async ({ query }, context) => {
      const tenant = tenantOf(context);
      const exportedAt = new Date();
      const includeShared = query.includeShared === "true";
      const summary = await begin(context, tenant, includeShared);
      if (summary === undefined) {
        throw new ProblemError("not_found", NO_WORKSPACE);
      }
      const body = exportStream(
        { page: (read) => tenant.withTenant((tx) => read(exportRepository(tx))), onFailure: onFailure(context) },
        { accountId: tenant.accountId, workspaceName: summary.workspaceName, exportedAt, includeShared },
      );
      return { status: 200, body, headers: { "Content-Disposition": `attachment; filename="${exportFilename(exportedAt)}"` } };
    }),

    route(exportNetscapeOperation).handle(async ({ query }, context) => {
      const tenant = tenantOf(context);
      const exportedAt = new Date();
      const includeShared = query.includeShared === "true";
      const summary = await begin(context, tenant, includeShared);
      if (summary === undefined) {
        throw new ProblemError("not_found", NO_WORKSPACE);
      }
      const body = exportNetscapeStream(
        { page: (read) => tenant.withTenant((tx) => read(exportRepository(tx))), onFailure: onFailure(context) },
        { accountId: tenant.accountId, includeShared },
      );
      return { status: 200, body, headers: { "Content-Type": EXPORT_NETSCAPE_CONTENT_TYPE, "Content-Disposition": `attachment; filename="${exportNetscapeFilename(exportedAt)}"` } };
    }),
  ];
}
