import { createBookmark as createBookmarkOperation, deleteBookmark as deleteBookmarkOperation, getBookmark, updateBookmark as updateBookmarkOperation, type BookmarkSchema } from "@slugbase/contracts";
import { createBookmark, deleteBookmark, readBookmark, updateBookmark, type BookmarkEntitlements, type BookmarkRecord, type BookmarkStore } from "@slugbase/core";
import { bookmarkRepository, type TenantTx } from "@slugbase/db";
import type { z } from "zod";
import { uuidv7 } from "../../auth/uuidv7.ts";
import { queueDomainEvent } from "../../events/publish.ts";
import type { ChainContext, RouteBinding } from "../../http/chain.ts";
import { ProblemError } from "../../http/problem.ts";
import type { RequestTenant } from "../../http/tenant.ts";
import { route } from "../register.ts";
import { acceptedVersions, entityTagOf } from "../workspaces/if-match.ts";

// POST /api/v1/bookmarks and GET /api/v1/bookmarks/{id} (doc 04 section 10.6, doc 02 section 5, doc 01 section 7.5, doc 05
// sections 2.2 and 2.4, doc 10 T1, T2, T11, T12 and T13). Both act in the workspace the request is bound to and name none;
// the authorization stage lets a member through (a session, or a token of the matching scope: write to create, read to get).
//
// Creating validates and normalises the URL before anything is written: only http and https are stored, a scheme
// of any other kind is `422 url_not_allowed`, and an empty, over-long or malformed URL is `422 validation_failed`. The
// workspace's `bookmarks.max` is read from the entitlement source before the transaction opens (a source that fails
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
// A bookmark is its owner's: reading, changing or deleting one that another member owns, one of another workspace and one that
// does not exist are the same `404 not_found` (doc 04 section 2.4), and the body carries the bookmark's version, which the `ETag`
// repeats.
//
// PATCH /api/v1/bookmarks/{id} is a JSON Merge Patch of the url, title, description and pinned fields. The URL goes through the
// normalisation of a creation, so its canonical form and host are derived again. `If-Match` is compared with the version under
// the bookmark's row lock and a mismatch is `412 precondition_failed` with nothing written; without the header the patch applies
// (an API token may leave it out). A patch that changes nothing answers 200 with the unchanged `ETag`. A plan-archived bookmark is
// not edited (doc 02 section 5.6) and is `404` like any bookmark the caller cannot change.
//
// DELETE /api/v1/bookmarks/{id} is a hard delete answered `204`. A hard delete keeps no tombstone, so the repeat is `404` (doc 04
// section 2.4), and the rows that reference the bookmark go with it by foreign key. Its place under `bookmarks.max` goes back in the
// same transaction (`sys_bookmark_delete`) unless the bookmark was plan-archived, which its owner may delete too.

const NO_WORKSPACE = "No such resource.";
const NO_SUCH_BOOKMARK = "No such resource.";
const URL_NOT_ALLOWED = "Only http and https URLs can be saved as a bookmark.";
const URL_INVALID = "The URL is not valid.";
const STALE_VERSION = "The bookmark has changed since it was read; read it again and retry.";
const AT_LIMIT = "Your plan allows no more bookmarks in this workspace.";
const URL_FIELD_CODES = { empty: "too_small", too_long: "too_big", malformed: "invalid_url" } as const;

export interface BookmarkRoutesOptions {
  /** The workspace's `bookmarks.max` of the entitlement source. */
  readonly entitlements: BookmarkEntitlements;
}

function tenantOf(context: ChainContext): RequestTenant {
  const tenant = context.get("tenant");
  if (tenant === undefined) {
    throw new ProblemError("not_found", NO_WORKSPACE);
  }
  return tenant;
}

/** The core store over the repository of the open transaction; the events become jobs of the same transaction. */
function storeOf(tx: TenantTx): BookmarkStore {
  const repository = bookmarkRepository(tx);
  return {
    create({ bookmark, ceiling, events }) {
      return repository.create({
        bookmark,
        ceiling: ceiling === "unlimited" ? null : ceiling,
        jobs: events.map((event) => queueDomainEvent(event.eventId, event.name, event.payload)),
      });
    },
    find: (bookmarkId) => repository.find(bookmarkId),
    update: (request) => repository.update(request),
    remove: (request) => repository.remove(request),
  };
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
    version: bookmark.version,
    createdAt: bookmark.createdAt.toISOString(),
    updatedAt: bookmark.updatedAt.toISOString(),
  };
}

export function bookmarkRoutes({ entitlements }: BookmarkRoutesOptions): RouteBinding[] {
  return [
    route(createBookmarkOperation).handle(async ({ body }, context) => {
      const tenant = tenantOf(context);
      const ceiling = await entitlements.limit(tenant.accountId, tenant.workspaceId, context.req.raw);
      if (ceiling === undefined) {
        throw new ProblemError("not_found", NO_WORKSPACE);
      }
      const outcome = await tenant.withTenant((tx) =>
        createBookmark(
          { store: storeOf(tx), newId: uuidv7 },
          {
            workspaceId: tenant.workspaceId,
            accountId: tenant.accountId,
            url: body.url,
            title: body.title,
            description: body.description,
            pinned: body.pinned,
            ceiling,
          },
        ),
      );
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
      const outcome = await tenant.withTenant((tx) =>
        updateBookmark({ store: storeOf(tx) }, { bookmarkId: params.id, accountId: tenant.accountId, patch: body, expectedVersions }),
      );
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
