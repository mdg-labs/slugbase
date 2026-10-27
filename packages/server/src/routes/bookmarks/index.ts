import { BOOKMARK_LIST_TOTAL_CAP, bulkBookmarks as bulkBookmarksOperation, createBookmark as createBookmarkOperation, deleteBookmark as deleteBookmarkOperation, getBookmark, listBookmarkIds as listBookmarkIdsOperation, listBookmarks as listBookmarksOperation, openBookmark as openBookmarkOperation, previewBulkBookmarks as previewBulkBookmarksOperation, updateBookmark as updateBookmarkOperation, type BookmarkSchema, type BulkBookmarksRequestSchema } from "@slugbase/contracts";
import { bulkBookmarks, createAuditWriter, createBookmark, deleteBookmark, listBookmarkIds, listBookmarks, normalizeSlug, openBookmark, previewBulkTags, readBookmark, updateBookmark, type AuditActor, type BookmarkBulkStore, type BookmarkCursors, type BookmarkEntitlements, type BookmarkListStore, type BookmarkRecord, type BookmarkStore, type BookmarkUsage } from "@slugbase/core";
import { accountProfileRepository, auditEventRepository, bookmarkRepository, isBookmarkSlugTaken, type TenantTx } from "@slugbase/db";
import type { z } from "zod";
import { createPageCursorCodec } from "../../auth/page-cursor.ts";
import { uuidv7 } from "../../auth/uuidv7.ts";
import { queueDomainEvent } from "../../events/publish.ts";
import type { Principal } from "../../http/authenticate.ts";
import type { ChainContext, RouteBinding } from "../../http/chain.ts";
import { ProblemError } from "../../http/problem.ts";
import type { RequestTenant } from "../../http/tenant.ts";
import { networkPrefixOf } from "../../http/trusted-proxy.ts";
import { route } from "../register.ts";
import { acceptedVersions, entityTagOf } from "../workspaces/if-match.ts";

// POST /api/v1/bookmarks and GET /api/v1/bookmarks/{id} (doc 04 section 10.6, doc 02 section 5, doc 01 section 7.5, doc 05
// sections 2.2 and 2.4, doc 10 T1, T2, T11, T12 and T13). Both act in the workspace the request is bound to and name none;
// the authorization stage lets a member through (a session, or a token of the matching scope: write to create, read to get).
//
// Creating validates and normalises the URL before anything is written: only http and https are stored, a scheme
// of any other kind is `422 url_not_allowed`, and an empty, over-long or malformed URL is `422 validation_failed`. The
// workspace's `bookmarks.max` is read from the entitlement source before the counter lock is taken: before the transaction opens, or, with an
// `Idempotency-Key`, inside the transaction stage 9a opened, which has not yet taken the counter lock (a source that fails
// answers 503 and writes nothing, never a creation without a ceiling), and the transaction takes one place under it:
// `sys_bookmark_count_take` locks the workspace's row, compares the workspace's `bookmark_count` with the ceiling and
// raises it, and the bookmark, the `bookmark.created` job and that count are one transaction, so two creations at the limit
// minus one make one and a failure of any write gives the place back. The operation accepts an `Idempotency-Key` (stage 9a, doc 04
// section 6.3): the stage opens the transaction this handler joins and claims the key in it first, so the key, the bookmark and
// the stored response commit together, and a replay restores the status and the body only, which is why the 201 carries no `Location`
// or `ETag`. At the limit the answer is
// `422 bookmark_limit_reached` with `limit` and `used`, and nothing is written. The operation declares no stage 9
// entitlement, since a limit of zero must read as `bookmark_limit_reached`, so the handler decides it.
//
// `slug` and `forwarding` on a creation and on a change (doc 02 section 6.1, doc 04 sections 1 and 10.6, doc 05 section 2.4): a slug is trimmed and lower-cased and
// then held to the grammar before anything is written, and one outside it is `422 validation_failed` on `slug`. A slug is unique per owner within the workspace: one
// the caller already uses on another bookmark is `409 slug_taken` on `slug` and writes nothing, and two requests that set the same slug at once make one success and one
// `409`, the key of the table being the judge (the loser's statement ends its transaction, which is answered as a slug that is taken). Forwarding needs a slug: creating with a
// slug and no `forwarding` stores true, forwarding without a slug, and clearing the slug of a bookmark that forwards unless the patch turns forwarding off, are `422
// validation_failed` on `forwarding`, and turning forwarding off keeps the slug. GET /api/v1/slugs/availability answers whether a slug is free (routes/slugs).
//
// A bookmark is its owner's: reading, changing or deleting one that another member owns, one of another workspace and one that
// does not exist are the same `404 not_found` (doc 04 section 2.4), and the body carries the bookmark's version, which the `ETag`
// repeats.
//
// GET /api/v1/bookmarks lists the caller's own bookmarks (doc 04 sections 6.1 and 10.6, doc 02 section 5.7): the filters `pinned`, `hasSlug`,
// `forwarding`, `url` (the canonical form of the value, for the duplicate warning) and `q` (the text of the search of doc 02 section 9.1, read through
// the system operation `sys_bookmark_match`, which the sort and the cursor leave as they are), six sorts with the identifier as tiebreak, and a page
// of at most 100 that the `nextCursor` resumes. The cursor is the sort key and identifier of the last item, signed with a subkey derived
// from the session secret for this list, over the account, the workspace, the filters and the sort it was issued for: a forged, altered or
// mismatched cursor is `400 bad_request`. `total` counts the filter's matches up to 10 000 and is null above, with `totalAtLeast`. A
// plan-archived bookmark is never listed. A `url` that cannot be a bookmark's URL is `422 validation_failed` on `url`.
//
// `folderIds` on a creation and on a change file the bookmark in the caller's own folders in the same transaction (a change replaces the folders
// it is in); a folder that is another member's, another workspace's or unknown is `404 not_found` and nothing is created or changed, and
// filing moves no version. `folderId` on the list narrows it to the bookmarks filed in one of the caller's folders (another member's or
// unknown is an empty page). Every bookmark body carries the `folders` it is filed in (doc 04 section 10.6, doc 02 sections 7.1 and 8.2).
//
// `tagIds` and `tagNames` on a creation and on a change put the caller's own tags on the bookmark in the same transaction (a change replaces the tags
// it has by the union of the two, and a name the caller has no tag of creates one); a tag named by identifier that is another member's, another
// workspace's or unknown is `404 not_found` and nothing is created, changed or tagged, and tagging moves no version. `tag` on the list, repeated,
// narrows it to the bookmarks that carry every one of the caller's tags named (AND; a tag that is not the caller's is an empty page). Every body
// carries the caller's own `tags` and no other member's (doc 04 section 10.6, doc 02 sections 7.2 and 8.2, doc 13 Q22).
//
// PATCH /api/v1/bookmarks/{id} is a JSON Merge Patch of the url, title, description, pinned, slug, forwarding, folderIds, tagIds and tagNames fields. The URL goes through the
// normalisation of a creation, so its canonical form and host are derived again. `If-Match` is compared with the version under
// the bookmark's row lock and a mismatch is `412 precondition_failed` with nothing written; without the header the patch applies
// (an API token may leave it out). A patch that changes nothing answers 200 with the unchanged `ETag`. A plan-archived bookmark is
// not edited (doc 02 section 5.6) and is `404` like any bookmark the caller cannot change.
//
// DELETE /api/v1/bookmarks/{id} is a hard delete answered `204`. A hard delete keeps no tombstone, so the repeat is `404` (doc 04
// section 2.4), and the rows that reference the bookmark go with it by foreign key. Its place under `bookmarks.max` goes back in the
// same transaction (`sys_bookmark_delete`) unless the bookmark was plan-archived, which its owner may delete too.
//
// GET /api/v1/bookmarks/ids (doc 04 sections 6.2 and 10.6, doc 02 section 5.7) takes the list's filters and answers the identifiers they
// match, newest first, up to the select-all cap of 5 000, with `truncated` when more match. POST /api/v1/bookmarks/bulk (doc 04
// sections 6.2, 7 and 10.6, doc 02 section 5.8) deletes, pins or unpins many of the caller's own bookmarks named by up to 1 000
// identifiers or by the same filters (a filter that matches more than the cap is `422 validation_failed`), in one transaction with the
// one `bookmark.bulk_deleted` audit event of a delete. It answers `requested`, `affected` and `skipped` counts and nothing else: another
// member's bookmark, another workspace's and a missing one are skipped as `not_found` alike. It takes from the `bulk` bucket, whose limit
// the `RATE_LIMIT_BULK_*` keys set. Both are registered before the routes with `{id}` in their path, so `ids` is not read as an identifier.
// The select-all and the bulk filter take `folderId` and `tag` as the list does, so a selection under a folder or tag filter is exactly the
// filtered bookmarks. `add_to_folder`, `move_to_folder` and `remove_from_folder` act with the `folderId` of the body and `add_tags` and
// `remove_tags` with its `tagIds`, all the caller's own: one that is not is `404 not_found` and nothing is changed (doc 02 section 5.8). They write
// links only, so no bookmark moves its version, and a plan-archived bookmark is skipped as `not_found`. POST /api/v1/bookmarks/bulk/preview
// answers what `add_tags` would do, with the tag set the bookmarks it reaches would carry, and writes nothing; it takes from the `read` bucket and, being a POST, needs a token of the `write` scope.
//
// POST /api/v1/bookmarks/{id}/open (doc 04 section 10.6, doc 02 section 5.5, doc 01 section 8.1, doc 10 T1, T2 and T12) answers the
// destination of a bookmark the caller can read and counts the open in the usage buffer of this process, which a timer writes to
// the database later (`sys_flush_open_counts`): the answer never waits for the database to take the count. A bookmark the caller
// cannot read is `404` and counts nothing, and the stored URL is checked to be http or https again before it is handed back. It is
// in the `go` rate bucket.

const NO_WORKSPACE = "No such resource.";
const NO_SUCH_BOOKMARK = "No such resource.";
const NO_SUCH_FOLDER = "No such resource.";
const NO_SUCH_TAG = "No such resource.";
const URL_NOT_ALLOWED = "Only http and https URLs can be saved as a bookmark.";
const DESTINATION_NOT_ALLOWED = "The bookmark's address is not an http or https URL, so it is not opened.";
const URL_INVALID = "The URL is not valid.";
const STALE_VERSION = "The bookmark has changed since it was read; read it again and retry.";
const AT_LIMIT = "Your plan allows no more bookmarks in this workspace.";
const BAD_CURSOR = "The cursor is not valid.";
const TOO_MANY_MATCHES = "The filter matches more bookmarks than one request can act on; narrow it.";
const SLUG_INVALID = "A slug has 1 to 64 lower-case letters, digits and hyphens and does not start with a hyphen.";
const FORWARDING_NEEDS_SLUG = "A bookmark forwards only while it has a slug; give it one or turn forwarding off.";
const URL_FIELD_CODES = { empty: "too_small", too_long: "too_big", malformed: "invalid_url" } as const;

export interface BookmarkRoutesOptions {
  /** The server secret the list cursors are signed with, through a key derived for this list alone. */
  readonly cursorSecret: string;
  /** The workspace's `bookmarks.max` of the entitlement source. */
  readonly entitlements: BookmarkEntitlements;
  /** Where an open is counted; the usage buffer of the server process. */
  readonly usage: BookmarkUsage;
}

function tenantOf(context: ChainContext): RequestTenant {
  const tenant = context.get("tenant");
  if (tenant === undefined) {
    throw new ProblemError("not_found", NO_WORKSPACE);
  }
  return tenant;
}

/** Who the audit log names for a change: the token when a bearer token made the request, the account otherwise. */
function auditActorOf(principal: Principal | undefined, accountId: string, label: string): AuditActor {
  return principal?.kind === "api-token" ? { type: "api_token", accountId, tokenId: principal.tokenId, label } : { type: "account", accountId, label };
}

/** A statement that met another bookmark's slug of the same owner at the key of the table ended its transaction with nothing written; that is the answer `slug_taken`. */
function slugTakenWhen(error: unknown): { readonly kind: "slug_taken" } {
  if (isBookmarkSlugTaken(error)) {
    return { kind: "slug_taken" };
  }
  throw error;
}

function slugTaken(slug: string | null | undefined): ProblemError {
  return new ProblemError("slug_taken", `You already use the slug "${normalizeSlug(slug ?? "")}" in this workspace.`, { errors: [{ path: "slug", code: "slug_taken" }] });
}

/** The core store over the repository of the open transaction; the events become jobs of the same transaction. */
function storeOf(tx: TenantTx): BookmarkStore {
  const repository = bookmarkRepository(tx);
  return {
    create({ bookmark, ceiling, events, folderIds, tags }) {
      return repository.create({
        bookmark,
        folderIds,
        tags,
        ceiling: ceiling === "unlimited" ? null : ceiling,
        jobs: events.map((event) => queueDomainEvent(event.eventId, event.name, event.payload)),
      });
    },
    find: (bookmarkId) => repository.find(bookmarkId),
    update: (request) => repository.update(request),
    remove: (request) => repository.remove(request),
  };
}

/** The bulk store over the repository of the open transaction. */
function bulkStoreOf(tx: TenantTx): BookmarkBulkStore {
  const repository = bookmarkRepository(tx);
  return {
    ids: (filter, limit) => repository.ids(filter, limit),
    removeMany: (bookmarkIds) => repository.removeMany({ bookmarkIds }),
    setPinned: (request) => repository.setPinned(request),
    fileIn: (request) => repository.fileIn(request),
    tag: (request) => repository.tag(request),
    previewTags: (request) => repository.previewTags(request),
  };
}

/** The list store over the repository of the open transaction. */
function listStoreOf(tx: TenantTx): BookmarkListStore {
  const repository = bookmarkRepository(tx);
  return { list: (request) => repository.list(request), count: (filter, limit) => repository.count(filter, limit) };
}

function bookmarkCursors(secret: string): BookmarkCursors {
  const codec = createPageCursorCodec(secret, "bookmarks");
  return {
    seal: (position, scope) => codec.encodeKey([position.key, position.id], scope),
    open(cursor, scope) {
      const key = codec.decodeKey(cursor, scope);
      const [position, id, ...rest] = key ?? [];
      return key === undefined || rest.length > 0 || position === undefined || typeof id !== "string" ? undefined : { key: position, id };
    },
  };
}

/** The tags of a `tag` filter, which is one identifier or several. */
function tagIdsOf(tag: string | readonly string[] | undefined): readonly string[] | undefined {
  return tag === undefined ? undefined : typeof tag === "string" ? [tag] : tag;
}

type BulkFilter = NonNullable<z.input<typeof BulkBookmarksRequestSchema>["filter"]>;

/** What a bulk request or its preview names: the identifiers, or the filter as the list takes it. */
function bulkTargetOf(body: { readonly ids?: readonly string[] | undefined; readonly filter?: BulkFilter | undefined }) {
  if (body.ids !== undefined) {
    return { kind: "ids", ids: body.ids } as const;
  }
  const filter = body.filter;
  return {
    kind: "filter",
    scope: filter?.scope ?? "mine",
    pinned: filter?.pinned,
    hasSlug: filter?.hasSlug,
    forwarding: filter?.forwarding,
    url: filter?.url,
    folderId: filter?.folderId,
    tagIds: tagIdsOf(filter?.tag),
    q: filter?.q,
  } as const;
}

function bookmarkBody(bookmark: BookmarkRecord): z.input<typeof BookmarkSchema> {
  return {
    id: bookmark.id,
    ownerId: bookmark.ownerId,
    url: bookmark.url,
    host: bookmark.host,
    title: bookmark.title,
    description: bookmark.description,
    slug: bookmark.slug,
    forwarding: bookmark.forwarding,
    pinned: bookmark.pinned,
    openCount: bookmark.openCount,
    lastOpenedAt: bookmark.lastOpenedAt === null ? null : bookmark.lastOpenedAt.toISOString(),
    folders: bookmark.folders.map((folder) => ({ id: folder.id, name: folder.name, icon: folder.icon, color: folder.color })),
    tags: bookmark.tags.map((tag) => ({ id: tag.id, name: tag.name })),
    version: bookmark.version,
    createdAt: bookmark.createdAt.toISOString(),
    updatedAt: bookmark.updatedAt.toISOString(),
  };
}

export function bookmarkRoutes({ entitlements, cursorSecret, usage }: BookmarkRoutesOptions): RouteBinding[] {
  const cursors = bookmarkCursors(cursorSecret);
  return [
    route(createBookmarkOperation).handle(async ({ body }, context) => {
      const tenant = tenantOf(context);
      const ceiling = await entitlements.limit(tenant.accountId, tenant.workspaceId, context.req.raw);
      if (ceiling === undefined) {
        throw new ProblemError("not_found", NO_WORKSPACE);
      }
      const outcome = await tenant
        .withTenant((tx) =>
          createBookmark(
            { store: storeOf(tx), newId: uuidv7 },
            {
              workspaceId: tenant.workspaceId,
              accountId: tenant.accountId,
              url: body.url,
              title: body.title,
              description: body.description,
              pinned: body.pinned,
              slug: body.slug,
              forwarding: body.forwarding,
              folderIds: body.folderIds,
              tagIds: body.tagIds,
              tagNames: body.tagNames,
              ceiling,
            },
          ),
        )
        .catch(slugTakenWhen);
      switch (outcome.kind) {
        case "created":
          return { status: 201, body: bookmarkBody(outcome.bookmark) };
        case "url_refused":
          if (outcome.reason === "not_http") {
            throw new ProblemError("url_not_allowed", URL_NOT_ALLOWED, { errors: [{ path: "url", code: "url_not_allowed" }] });
          }
          throw new ProblemError("validation_failed", URL_INVALID, { errors: [{ path: "url", code: URL_FIELD_CODES[outcome.reason] }] });
        case "limit_reached":
          throw new ProblemError("bookmark_limit_reached", AT_LIMIT, { members: { limit: outcome.limit, used: outcome.used } });
        case "unavailable":
          throw new ProblemError("not_found", NO_WORKSPACE);
        case "folder_not_found":
          throw new ProblemError("not_found", NO_SUCH_FOLDER);
        case "tag_not_found":
          throw new ProblemError("not_found", NO_SUCH_TAG);
        case "slug_invalid":
          throw new ProblemError("validation_failed", SLUG_INVALID, { errors: [{ path: "slug", code: "invalid_slug" }] });
        case "forwarding_requires_slug":
          throw new ProblemError("validation_failed", FORWARDING_NEEDS_SLUG, { errors: [{ path: "forwarding", code: "forwarding_requires_slug" }] });
        case "slug_taken":
          throw slugTaken(body.slug);
      }
    }),

    route(listBookmarksOperation).handle(async ({ query }, context) => {
      const tenant = tenantOf(context);
      const outcome = await tenant.withTenant((tx) =>
        listBookmarks(
          { store: listStoreOf(tx), cursors },
          {
            workspaceId: tenant.workspaceId,
            accountId: tenant.accountId,
            scope: query.scope,
            pinned: query.pinned === undefined ? undefined : query.pinned === "true",
            hasSlug: query.hasSlug === undefined ? undefined : query.hasSlug === "true",
            forwarding: query.forwarding === undefined ? undefined : query.forwarding === "true",
            url: query.url,
            folderId: query.folderId,
            tagIds: tagIdsOf(query.tag),
            q: query.q,
            sort: query.sort,
            limit: query.limit,
            cursor: query.cursor,
          },
        ),
      );
      switch (outcome.kind) {
        case "listed":
          return {
            status: 200,
            body: {
              items: outcome.items.map(bookmarkBody),
              nextCursor: outcome.nextCursor,
              total: outcome.total,
              ...(outcome.total === null ? { totalAtLeast: BOOKMARK_LIST_TOTAL_CAP } : {}),
            },
          };
        case "bad_cursor":
          throw new ProblemError("bad_request", BAD_CURSOR);
        case "url_refused":
          throw new ProblemError("validation_failed", URL_INVALID, { errors: [{ path: "url", code: outcome.reason === "not_http" ? "url_not_allowed" : URL_FIELD_CODES[outcome.reason] }] });
      }
    }),

    route(listBookmarkIdsOperation).handle(async ({ query }, context) => {
      const tenant = tenantOf(context);
      const outcome = await tenant.withTenant((tx) =>
        listBookmarkIds(
          { store: bulkStoreOf(tx) },
          {
            accountId: tenant.accountId,
            scope: query.scope,
            pinned: query.pinned === undefined ? undefined : query.pinned === "true",
            hasSlug: query.hasSlug === undefined ? undefined : query.hasSlug === "true",
            forwarding: query.forwarding === undefined ? undefined : query.forwarding === "true",
            url: query.url,
            folderId: query.folderId,
            tagIds: tagIdsOf(query.tag),
            q: query.q,
          },
        ),
      );
      if (outcome.kind === "url_refused") {
        throw new ProblemError("validation_failed", URL_INVALID, { errors: [{ path: "url", code: outcome.reason === "not_http" ? "url_not_allowed" : URL_FIELD_CODES[outcome.reason] }] });
      }
      return { status: 200, body: { ids: [...outcome.ids], truncated: outcome.truncated } };
    }),

    route(bulkBookmarksOperation).handle(async ({ body }, context) => {
      const tenant = tenantOf(context);
      const ipPrefix = networkPrefixOf(context.get("clientIp")) ?? null;
      const target = bulkTargetOf(body);
      const outcome = await tenant.withTenant(async (tx) => {
        const profile = await accountProfileRepository(tx).profile();
        if (profile === undefined) {
          return { kind: "unavailable" } as const;
        }
        const actor = auditActorOf(context.get("principal"), tenant.accountId, profile.displayName);
        return bulkBookmarks(
          { store: bulkStoreOf(tx), audit: createAuditWriter({ store: auditEventRepository(tx), newId: uuidv7 }) },
          { workspaceId: tenant.workspaceId, accountId: tenant.accountId, actor, ipPrefix, action: body.action, target, folderId: body.folderId, tagIds: body.tagIds },
        );
      });
      switch (outcome.kind) {
        case "done":
          return { status: 200, body: { requested: outcome.requested, affected: outcome.affected, skipped: outcome.requested - outcome.affected, skippedReasons: outcome.skipped } };
        case "too_many":
          throw new ProblemError("validation_failed", TOO_MANY_MATCHES, { errors: [{ path: body.ids === undefined ? "filter" : "ids", code: "too_big" }] });
        case "url_refused":
          throw new ProblemError("validation_failed", URL_INVALID, { errors: [{ path: "filter.url", code: outcome.reason === "not_http" ? "url_not_allowed" : URL_FIELD_CODES[outcome.reason] }] });
        case "unavailable":
          throw new ProblemError("not_found", NO_WORKSPACE);
        case "target_not_found":
          throw new ProblemError("not_found", body.folderId === undefined ? NO_SUCH_TAG : NO_SUCH_FOLDER);
      }
    }),

    route(previewBulkBookmarksOperation).handle(async ({ body }, context) => {
      const tenant = tenantOf(context);
      const outcome = await tenant.withTenant((tx) => previewBulkTags({ store: bulkStoreOf(tx) }, { accountId: tenant.accountId, target: bulkTargetOf(body), tagIds: body.tagIds }));
      switch (outcome.kind) {
        case "previewed":
          return {
            status: 200,
            body: {
              requested: outcome.requested,
              affected: outcome.affected,
              skipped: outcome.requested - outcome.affected,
              skippedReasons: outcome.skipped,
              tags: outcome.tags.map((tag) => ({ id: tag.id, name: tag.name, bookmarkCount: tag.bookmarkCount, added: tag.added })),
            },
          };
        case "too_many":
          throw new ProblemError("validation_failed", TOO_MANY_MATCHES, { errors: [{ path: body.ids === undefined ? "filter" : "ids", code: "too_big" }] });
        case "url_refused":
          throw new ProblemError("validation_failed", URL_INVALID, { errors: [{ path: "filter.url", code: outcome.reason === "not_http" ? "url_not_allowed" : URL_FIELD_CODES[outcome.reason] }] });
        case "target_not_found":
          throw new ProblemError("not_found", NO_SUCH_TAG);
      }
    }),

    route(getBookmark).handle(async ({ params }, context) => {
      const tenant = tenantOf(context);
      const bookmark = await tenant.withTenant((tx) => readBookmark({ store: storeOf(tx) }, { bookmarkId: params.id, accountId: tenant.accountId }));
      if (bookmark === undefined) {
        throw new ProblemError("not_found", NO_SUCH_BOOKMARK);
      }
      return { status: 200, body: bookmarkBody(bookmark), headers: { ETag: entityTagOf(bookmark.version) } };
    }),

    route(updateBookmarkOperation).handle(async ({ params, body }, context) => {
      const tenant = tenantOf(context);
      const expectedVersions = acceptedVersions(context.req.header("if-match"));
      const outcome = await tenant
        .withTenant((tx) => updateBookmark({ store: storeOf(tx), newId: uuidv7 }, { bookmarkId: params.id, accountId: tenant.accountId, patch: body, expectedVersions }))
        .catch(slugTakenWhen);
      switch (outcome.kind) {
        case "updated":
        case "unchanged":
          return { status: 200, body: bookmarkBody(outcome.bookmark), headers: { ETag: entityTagOf(outcome.bookmark.version) } };
        case "url_refused":
          if (outcome.reason === "not_http") {
            throw new ProblemError("url_not_allowed", URL_NOT_ALLOWED, { errors: [{ path: "url", code: "url_not_allowed" }] });
          }
          throw new ProblemError("validation_failed", URL_INVALID, { errors: [{ path: "url", code: URL_FIELD_CODES[outcome.reason] }] });
        case "stale":
          throw new ProblemError("precondition_failed", STALE_VERSION);
        case "not_found":
          throw new ProblemError("not_found", NO_SUCH_BOOKMARK);
        case "folder_not_found":
          throw new ProblemError("not_found", NO_SUCH_FOLDER);
        case "tag_not_found":
          throw new ProblemError("not_found", NO_SUCH_TAG);
        case "slug_invalid":
          throw new ProblemError("validation_failed", SLUG_INVALID, { errors: [{ path: "slug", code: "invalid_slug" }] });
        case "forwarding_requires_slug":
          throw new ProblemError("validation_failed", FORWARDING_NEEDS_SLUG, { errors: [{ path: "forwarding", code: "forwarding_requires_slug" }] });
        case "slug_taken":
          throw slugTaken(body.slug);
      }
    }),

    route(openBookmarkOperation).handle(async ({ params }, context) => {
      const tenant = tenantOf(context);
      const outcome = await tenant.withTenant((tx) => openBookmark({ store: storeOf(tx), usage }, { bookmarkId: params.id, accountId: tenant.accountId }));
      switch (outcome.kind) {
        case "opened":
          return { status: 200, body: { url: outcome.url } };
        case "not_found":
          throw new ProblemError("not_found", NO_SUCH_BOOKMARK);
        case "url_refused":
          throw new ProblemError("url_not_allowed", DESTINATION_NOT_ALLOWED);
      }
    }),

    route(deleteBookmarkOperation).handle(async ({ params }, context) => {
      const tenant = tenantOf(context);
      const deleted = await tenant.withTenant((tx) => deleteBookmark({ store: storeOf(tx) }, { bookmarkId: params.id, accountId: tenant.accountId }));
      if (!deleted) {
        throw new ProblemError("not_found", NO_SUCH_BOOKMARK);
      }
      return { status: 204 };
    }),
  ];
}
