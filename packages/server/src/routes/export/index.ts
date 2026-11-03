import { EXPORT_COUNT_HEADER, exportJson as exportJsonOperation, EXPORT_NETSCAPE_CONTENT_TYPE, EXPORT_SELECTION_FILTERS, exportNetscape as exportNetscapeOperation, type ExportQuerySchema } from "@slugbase/contracts";
import { createAuditWriter, exportFilename, exportNetscapeFilename, exportNetscapeStream, exportStream, resolveExportSelection, startExport, type AuditActor, type ExportSelection, type ExportSummary } from "@slugbase/core";
import { accountProfileRepository, auditEventRepository, bookmarkRepository, exportRepository } from "@slugbase/db";
import type { z } from "zod";
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
// from the repository's pages, each in a transaction of its own that is over before the page is sent (core's `exportStream`), so the server holds one page of an export whatever its size, besides the ref of each bookmark of the JSON document that has a slug and forwards (core's `exportStream` keeps those for the length of the download, so the memory of the JSON export grows with the number of such bookmarks), and no
// transaction waits on a slow client; nothing is stored. A page that cannot be read ends the connection with the document unfinished, so what was received does not parse. Every read names the
// account of the request as the owner (src/repositories/export.ts), so another member's content, content with no owner and anything of another workspace is in no answer. The Netscape file is the same
// export in the other format: it starts the same way (one `export.created`, counts only, before the first byte) and is streamed the same way, and it is answered as `text/html; charset=utf-8` with the
// disposition of an attachment, which with the `nosniff` of every response means a navigation to it downloads the file and never renders it in the origin of the application (doc 10 T14).
//
// The JSON document also carries the caller's remembered slug choices (`goPreferences`): the choices for the caller's own bookmarks that still have the slug and forward, each as the slug and the `ref` of the bookmark in the same document, read from the same
// repository after the bookmarks. The Netscape file names no go preference.
//
// A selection (doc 02 section 5.8): `id` (at most 100, repeated) or any filter of the list (`scope`, `folderId`, `tag`, `pinned`, `q`, ...) makes the export that of the named or matching bookmarks only. The counting transaction resolves it before anything is
// recorded: the identifiers as they are named, the filters through the same read as the select-all of the list (`bookmarkRepository(tx).ids`, scope `all` when left out, as the list's), refused with `422` above the select-all cap and never cut at it. The identifiers
// are then one more condition of every read of the export (src/repositories/export.ts), which matches what the account owns or can read through a share and nothing else, so an identifier of a bookmark it can neither own nor read is dropped there
// and is in no byte of the file, no count and no field of the audit event; the answer for it is the answer for an identifier that names nothing. A selection holds the bookmarks shared with the caller that it names or matches, which is why `includeShared` is not
// taken with it (the contract refuses the pair). The header `X-Export-Count` tells how many bookmarks the file holds when it begins, the caller's own and the shared ones.
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

const TOO_MANY_MATCHES = "The filters match more bookmarks than one export can hold; narrow them.";

const URL_INVALID = "The URL is not valid.";

const URL_FIELD_CODES = { empty: "too_small", too_long: "too_big", malformed: "invalid_url" } as const;

type ExportQuery = z.output<typeof ExportQuerySchema>;

function idsOf(id: string | readonly string[]): readonly string[] {
  return typeof id === "string" ? [id] : id;
}

/** What the query selects: the bookmarks named by `id`, the ones the filters of the list match (scope `all` when left out, as the list's), or nothing, which is the whole export. */
function selectionOf(query: ExportQuery, accountId: string): ExportSelection | undefined {
  if (query.id !== undefined) {
    return { kind: "ids", ids: idsOf(query.id) };
  }
  if (EXPORT_SELECTION_FILTERS.every((name) => query[name] === undefined)) {
    return undefined;
  }
  return {
    kind: "filter",
    filter: {
      accountId,
      scope: query.scope ?? "all",
      pinned: query.pinned === undefined ? undefined : query.pinned === "true",
      hasSlug: query.hasSlug === undefined ? undefined : query.hasSlug === "true",
      forwarding: query.forwarding === undefined ? undefined : query.forwarding === "true",
      url: query.url,
      folderId: query.folderId,
      tagIds: query.tag === undefined ? undefined : idsOf(query.tag),
      q: query.q,
    },
  };
}

/** What the export reads: the summary the event was recorded with, and the identifiers of the selection when there is one. */
interface Begun {
  readonly summary: ExportSummary;
  readonly only: readonly string[] | undefined;
}

/**
 * Resolves the selection if there is one, counts what the caller owns and records the export, in one transaction; undefined when the workspace cannot be read, which ends the request. A selection that cannot be exported is
 * a `422` before anything is recorded.
 */
async function begin(context: ChainContext, tenant: RequestTenant, query: ExportQuery): Promise<Begun | undefined> {
  const ipPrefix = networkPrefixOf(context.get("clientIp")) ?? null;
  const includeShared = query.includeShared === "true";
  const selection = selectionOf(query, tenant.accountId);
  const started = await tenant.withTenant(async (tx) => {
    const profile = await accountProfileRepository(tx).profile();
    if (profile === undefined) {
      return { kind: "unavailable" } as const;
    }
    const resolved = selection === undefined ? undefined : await resolveExportSelection({ ids: (filter, limit) => bookmarkRepository(tx).ids(filter, limit) }, selection);
    if (resolved?.kind === "too_many") {
      throw new ProblemError("validation_failed", TOO_MANY_MATCHES, { errors: [{ path: selection?.kind === "ids" ? "id" : "filter", code: "too_big" }] });
    }
    if (resolved?.kind === "url_refused") {
      throw new ProblemError("validation_failed", URL_INVALID, { errors: [{ path: "url", code: resolved.reason === "not_http" ? "url_not_allowed" : URL_FIELD_CODES[resolved.reason] }] });
    }
    const only = resolved?.only;
    const outcome = await startExport(
      { store: exportRepository(tx), audit: createAuditWriter({ store: auditEventRepository(tx), newId: uuidv7 }) },
      { workspaceId: tenant.workspaceId, accountId: tenant.accountId, actor: auditActorOf(context, tenant.accountId, profile.displayName), ipPrefix, includeShared, only },
    );
    return outcome.kind === "unavailable" ? ({ kind: "unavailable" } as const) : ({ kind: "started", summary: outcome.summary, only } as const);
  });
  return started.kind === "unavailable" ? undefined : { summary: started.summary, only: started.only };
}

/** How many bookmarks the file holds when it begins: the caller's own and the shared ones it reads. */
function countOf(summary: ExportSummary): string {
  return String(summary.bookmarks + summary.shared);
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
      const begun = await begin(context, tenant, query);
      if (begun === undefined) {
        throw new ProblemError("not_found", NO_WORKSPACE);
      }
      const body = exportStream(
        { page: (read) => tenant.withTenant((tx) => read(exportRepository(tx))), onFailure: onFailure(context) },
        { accountId: tenant.accountId, workspaceName: begun.summary.workspaceName, exportedAt, includeShared, only: begun.only },
      );
      return { status: 200, body, headers: { "Content-Disposition": `attachment; filename="${exportFilename(exportedAt)}"`, [EXPORT_COUNT_HEADER]: countOf(begun.summary) } };
    }),

    route(exportNetscapeOperation).handle(async ({ query }, context) => {
      const tenant = tenantOf(context);
      const exportedAt = new Date();
      const includeShared = query.includeShared === "true";
      const begun = await begin(context, tenant, query);
      if (begun === undefined) {
        throw new ProblemError("not_found", NO_WORKSPACE);
      }
      const body = exportNetscapeStream(
        { page: (read) => tenant.withTenant((tx) => read(exportRepository(tx))), onFailure: onFailure(context) },
        { accountId: tenant.accountId, includeShared, only: begun.only },
      );
      return {
        status: 200,
        body,
        headers: { "Content-Type": EXPORT_NETSCAPE_CONTENT_TYPE, "Content-Disposition": `attachment; filename="${exportNetscapeFilename(exportedAt)}"`, [EXPORT_COUNT_HEADER]: countOf(begun.summary) },
      };
    }),
  ];
}
