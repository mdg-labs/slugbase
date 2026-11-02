import { importJson as importJsonOperation } from "@slugbase/contracts";
import { createAuditWriter, importBookmarks, previewImport, type AuditActor, type BookmarkEntitlements, type ImportStore } from "@slugbase/core";
import { accountProfileRepository, auditEventRepository, importRepository, type TenantTx } from "@slugbase/db";
import { ascendingUuidv7, uuidv7 } from "../../auth/uuidv7.ts";
import type { ChainContext, RouteBinding } from "../../http/chain.ts";
import { ProblemError } from "../../http/problem.ts";
import type { RequestTenant } from "../../http/tenant.ts";
import { networkPrefixOf } from "../../http/trusted-proxy.ts";
import { queueDomainEvent } from "../../events/publish.ts";
import { route } from "../register.ts";

// POST /api/v1/import/json (doc 04 section 10.9, doc 02 section 13.1, doc 01 section 7.5, doc 10 T1, T11 and T13). It acts in the workspace the request is bound to and names none; the authorization stage lets a member
// through by a session or by an API token of the write scope, the body-limits stage refuses a body over 5 MiB, the validation stage refuses a file that is not the format, and the request is in the `bulk` rate bucket.
// The operation is synchronous. With `dryRun=true` the handler reads the workspace's bookmark counter and the caller's own canonical URLs in one transaction and writes nothing, so a request that carries an
// `Idempotency-Key` stores its answer under the key (the idempotency stage's own row) and changes nothing else. Otherwise the import is one transaction, the one the idempotency stage opens when there is a key: it takes
// the places the file needs under the workspace's `bookmarks.max` (the entitlement is decided here, because the room is the counter under the workspace's row lock), inserts the bookmarks in batches in the order of
// the file with ascending identifiers, queues `bookmark.created` for each (the page's metadata is not fetched: the file is the member's, and a fetch for each of up to 5 000 bookmarks is an amplification the member
// chooses), and records one `import.completed` audit event with the account or the token as the actor. Between the places and the bookmarks it gets or creates the folders and tags of the file for the caller by name, and it
// files and tags each bookmark by its own names; a slug the caller has already, or that an earlier bookmark of the file keeps, is dropped from its bookmark, which is still imported, and listed in the answer. A failure of any of these rolls back all of them, and the stage stores the answer of a request that succeeded only.
// Every read and write names the workspace and the account of the request, so another member's bookmark and anything of another workspace is no duplicate of the file's and is never changed.

const NO_WORKSPACE = "No such resource.";

function tenantOf(context: ChainContext): RequestTenant {
  const tenant = context.get("tenant");
  if (tenant === undefined) {
    throw new ProblemError("not_found", NO_WORKSPACE);
  }
  return tenant;
}

/** Who the audit log names for an import: the token when a bearer token made the request, the account otherwise. */
function auditActorOf(context: ChainContext, accountId: string, label: string): AuditActor {
  const principal = context.get("principal");
  return principal?.kind === "api-token" ? { type: "api_token", accountId, tokenId: principal.tokenId, label } : { type: "account", accountId, label };
}

/** The core store over the repository of the open transaction; the events become jobs of the same transaction. */
function storeOf(tx: TenantTx): ImportStore {
  const repository = importRepository(tx);
  return {
    bookmarkCount: () => repository.bookmarkCount(),
    existingCanonicalUrls: (canonicals) => repository.existingCanonicalUrls(canonicals),
    existingSlugs: (slugs) => repository.existingSlugs(slugs),
    existingFolderNames: (names) => repository.existingFolderNames(names),
    existingTagNames: (names) => repository.existingTagNames(names),
    firstSameNames: (names) => repository.firstSameNames(names),
    resolveFolders: (folders) => repository.resolveFolders(folders),
    resolveTags: (tags) => repository.resolveTags(tags),
    linkBookmarks: (links) => repository.linkBookmarks(links),
    takePlaces: (ceiling, wanted) => repository.takePlaces(ceiling, wanted),
    insertBookmarks: ({ bookmarks, events }) =>
      repository.insertBookmarks({ bookmarks, jobs: events.map((event) => queueDomainEvent(event.eventId, event.name, event.payload)) }),
  };
}

export interface ImportRoutesOptions {
  /** Gives the workspace's `bookmarks.max`, the ceiling of the room the import is judged against. */
  readonly entitlements: BookmarkEntitlements;
}

export function importRoutes({ entitlements }: ImportRoutesOptions): RouteBinding[] {
  return [
    route(importJsonOperation).handle(async ({ query, body }, context) => {
      const tenant = tenantOf(context);
      const ceiling = await entitlements.limit(tenant.accountId, tenant.workspaceId, context.req.raw);
      if (ceiling === undefined) {
        throw new ProblemError("not_found", NO_WORKSPACE);
      }
      const skipDuplicates = query.skipDuplicates !== "false";
      if (query.dryRun === "true") {
        const previewed = await tenant.withTenant((tx) => previewImport({ store: importRepository(tx) }, { file: body, skipDuplicates, ceiling }));
        if (previewed.kind === "unavailable") {
          throw new ProblemError("not_found", NO_WORKSPACE);
        }
        return { status: 200, body: previewed.result };
      }
      const ipPrefix = networkPrefixOf(context.get("clientIp")) ?? null;
      const outcome = await tenant.withTenant(async (tx) => {
        const profile = await accountProfileRepository(tx).profile();
        if (profile === undefined) {
          return { kind: "unavailable" } as const;
        }
        return importBookmarks(
          { store: storeOf(tx), audit: createAuditWriter({ store: auditEventRepository(tx), newId: uuidv7 }), newBookmarkId: ascendingUuidv7(), newId: uuidv7 },
          { file: body, skipDuplicates, ceiling, workspaceId: tenant.workspaceId, accountId: tenant.accountId, actor: auditActorOf(context, tenant.accountId, profile.displayName), ipPrefix },
        );
      });
      if (outcome.kind === "unavailable") {
        throw new ProblemError("not_found", NO_WORKSPACE);
      }
      return { status: 200, body: outcome.result };
    }),
  ];
}
