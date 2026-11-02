import { IMPORT_MAX_LINKS, IMPORT_MAX_NEW_NAMES, importJson as importJsonOperation, importNetscape as importNetscapeOperation, type ImportQuerySchema, type ImportRequest } from "@slugbase/contracts";
import type { z } from "zod";
import { createAuditWriter, importBookmarks, previewImport, type AuditActor, type BookmarkEntitlements, type ImportStore } from "@slugbase/core";
import { accountProfileRepository, auditEventRepository, importRepository, type TenantTx } from "@slugbase/db";
import { ascendingUuidv7, uuidv7 } from "../../auth/uuidv7.ts";
import type { ChainContext, RouteBinding } from "../../http/chain.ts";
import { ProblemError } from "../../http/problem.ts";
import type { RequestTenant } from "../../http/tenant.ts";
import { networkPrefixOf } from "../../http/trusted-proxy.ts";
import { queueDomainEvent } from "../../events/publish.ts";
import { route } from "../register.ts";
import { uploadedBookmarks } from "./upload.ts";

// POST /api/v1/import/json (doc 04 section 10.9, doc 02 section 13.1, doc 01 section 7.5, doc 10 T1, T11 and T13). It acts in the workspace the request is bound to and names none; the authorization stage lets a member
// through by a session or by an API token of the write scope, the body-limits stage refuses a body over 5 MiB, the validation stage refuses a file that is not the format, and the request is in the `bulk` rate bucket.
// The operation is synchronous. With `dryRun=true` the handler reads the workspace's bookmark counter and the caller's own canonical URLs in one transaction and writes nothing, so a request that carries an
// `Idempotency-Key` stores its answer under the key (the idempotency stage's own row) and changes nothing else. Otherwise the import is one transaction, the one the idempotency stage opens when there is a key: it takes
// the places the file needs under the workspace's `bookmarks.max` (the entitlement is decided here, because the room is the counter under the workspace's row lock), inserts the bookmarks in batches in the order of
// the file with ascending identifiers, queues `bookmark.created` for each (the page's metadata is not fetched: the file is the member's, and a fetch for each of up to 5 000 bookmarks is an amplification the member
// chooses), and records one `import.completed` audit event with the account or the token as the actor. Between the places and the bookmarks it gets or creates the folders and tags of the file for the caller by name, and it
// files and tags each bookmark by its own names; a slug the caller has already, or that an earlier bookmark of the file keeps, is dropped from its bookmark, which is still imported, and listed in the answer. The remembered slug choices of the file (`goPreferences`) are restored after the bookmarks, in the same transaction and in batches, for the bookmarks that kept the slug of the choice and forward, through the check of a member's own choice; a dry run restores none. A failure of any of these rolls back all of them, and the stage stores the answer of a request that succeeded only.
// A file that would create more than 10 000 new folders and tags together is `422 validation_failed` with the field code `too_many_new_names`, in the dry run and in the write: the write decides it before it takes the
// workspace's row, and the refusal that is only known under the lock throws inside the transaction, so nothing is committed. A file whose bookmarks would make more than 100 000 folder and tag links together is refused the same
// way, with the field code `too_many_links`. Every read and write names the workspace and the account of the request, so another member's bookmark and anything of another workspace is no duplicate of the file's and is never changed.

// POST /api/v1/import/netscape (doc 04 section 10.9, doc 02 section 13.1) takes a browser's bookmark file as a multipart upload (`upload.ts`), reads it into bookmarks and hands them to the same function as the JSON import, so the
// two have one set of rules, caps, dry run, room under `bookmarks.max`, audit event and answer, and the one place that decides each of them. It declares no token scope, so only a session reaches it; it is the only route that accepts multipart.

const NO_WORKSPACE = "No such resource.";

function tooManyNames(newNames: number): ProblemError {
  return new ProblemError(
    "validation_failed",
    `The file would create ${String(newNames)} new folders and tags together; one import creates at most ${String(IMPORT_MAX_NEW_NAMES)}. Names you already have do not count.`,
    { errors: [{ path: "", code: "too_many_new_names" }] },
  );
}

function tooManyLinks(links: number): ProblemError {
  return new ProblemError(
    "validation_failed",
    `The file would make ${String(links)} folder and tag links together; one import makes at most ${String(IMPORT_MAX_LINKS)}. A bookmark counts one link for each folder and each tag it names.`,
    { errors: [{ path: "", code: "too_many_links" }] },
  );
}

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
    rememberChoices: (choices) => repository.rememberChoices(choices),
    takePlaces: (ceiling, wanted) => repository.takePlaces(ceiling, wanted),
    insertBookmarks: ({ bookmarks, events }) =>
      repository.insertBookmarks({ bookmarks, jobs: events.map((event) => queueDomainEvent(event.eventId, event.name, event.payload)) }),
  };
}

export interface ImportRoutesOptions {
  /** Gives the workspace's `bookmarks.max`, the ceiling of the room the import is judged against. */
  readonly entitlements: BookmarkEntitlements;
}

type ImportQuery = z.output<typeof ImportQuerySchema>;

/** The import of a file the caller has read into bookmarks: a dry run, or the one transaction that writes it. Both routes of the import end here. */
async function runImport(context: ChainContext, query: ImportQuery, file: ImportRequest, entitlements: BookmarkEntitlements) {
  const tenant = tenantOf(context);
  const ceiling = await entitlements.limit(tenant.accountId, tenant.workspaceId, context.req.raw);
  if (ceiling === undefined) {
    throw new ProblemError("not_found", NO_WORKSPACE);
  }
  const skipDuplicates = query.skipDuplicates !== "false";
  if (query.dryRun === "true") {
    const previewed = await tenant.withTenant((tx) => previewImport({ store: importRepository(tx) }, { file, skipDuplicates, ceiling }));
    if (previewed.kind === "unavailable") {
      throw new ProblemError("not_found", NO_WORKSPACE);
    }
    if (previewed.kind === "too_many_names") {
      throw tooManyNames(previewed.newNames);
    }
    if (previewed.kind === "too_many_links") {
      throw tooManyLinks(previewed.links);
    }
    return { status: 200 as const, body: previewed.result };
  }
  const ipPrefix = networkPrefixOf(context.get("clientIp")) ?? null;
  const outcome = await tenant.withTenant(async (tx) => {
    const profile = await accountProfileRepository(tx).profile();
    if (profile === undefined) {
      return { kind: "unavailable" } as const;
    }
    const imported = await importBookmarks(
      { store: storeOf(tx), audit: createAuditWriter({ store: auditEventRepository(tx), newId: uuidv7 }), newBookmarkId: ascendingUuidv7(), newId: uuidv7 },
      { file, skipDuplicates, ceiling, workspaceId: tenant.workspaceId, accountId: tenant.accountId, actor: auditActorOf(context, tenant.accountId, profile.displayName), ipPrefix },
    );
    if (imported.kind === "too_many_names") {
      throw tooManyNames(imported.newNames);
    }
    if (imported.kind === "too_many_links") {
      throw tooManyLinks(imported.links);
    }
    return imported;
  });
  if (outcome.kind === "unavailable") {
    throw new ProblemError("not_found", NO_WORKSPACE);
  }
  return { status: 200 as const, body: outcome.result };
}

export function importRoutes({ entitlements }: ImportRoutesOptions): RouteBinding[] {
  return [
    route(importJsonOperation).handle(({ query, body }, context) => runImport(context, query, body, entitlements)),
    // The only multipart route: the upload is read by the handler, and what it lists goes through the same service as a JSON file.
    route(importNetscapeOperation).handle(async ({ query }, context) => runImport(context, query, await uploadedBookmarks(context), entitlements), { acceptsMultipart: true }),
  ];
}
