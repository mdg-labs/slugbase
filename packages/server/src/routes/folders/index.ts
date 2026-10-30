import { FOLDER_LIST_TOTAL_CAP, addFolderBookmarks as addFolderBookmarksOperation, createFolder as createFolderOperation, deleteFolder as deleteFolderOperation, getFolder as getFolderOperation, listFolders as listFoldersOperation, removeFolderBookmarks as removeFolderBookmarksOperation, updateFolder as updateFolderOperation, type FolderSchema } from "@slugbase/contracts";
import { createFolder, deleteFolder, fileBookmarks, listFolders, readFolder, unfileBookmarks, updateFolder, type FolderCursors, type FolderRecord } from "@slugbase/core";
import { folderRepository, isFolderNameTaken } from "@slugbase/db";
import type { z } from "zod";
import { createPageCursorCodec } from "../../auth/page-cursor.ts";
import { uuidv7 } from "../../auth/uuidv7.ts";
import type { ChainContext, RouteBinding } from "../../http/chain.ts";
import { ProblemError } from "../../http/problem.ts";
import type { RequestTenant } from "../../http/tenant.ts";
import { route } from "../register.ts";
import { acceptedVersions, entityTagOf } from "../workspaces/if-match.ts";

// POST, GET /api/v1/folders and GET, PATCH, DELETE /api/v1/folders/{id} (doc 04 section 10.7, doc 02 sections 7.1 and 8.2, doc 05 section 2.4, doc 10
// T1 and T2). All five act in the workspace the request is bound to and name none; the authorization stage lets a member through (a
// session, or a token of the matching scope: write to create, change and delete, read to list and get).
//
// A folder is its owner's to change and readable by the members it is shared with. The statements of the repository name the viewer or the owner as
// well as the workspace, so another member's folder that is not shared with the caller, a folder of another workspace and one that does not exist are
// the same `404 not_found` (doc 04 section 2.4); a change, a deletion or a filing into a folder that is shared with the caller, who can read it, is
// `403 forbidden` and writes nothing (a share gives read access only, Q22). A name is 1 to 64 characters
// after the whitespace around it is removed, stored as entered and unique per owner without regard to case: creating or renaming to a name
// the caller already uses on another folder is `409 name_taken` and writes nothing. The icon is one of the list `@slugbase/contracts`
// publishes (`folder` when left out) and the colour is 1 to 8 (1 when left out). Deleting a folder removes the associations of its
// bookmarks, which stay; a hard delete keeps no tombstone, so the repeat is `404`.
//
// GET /api/v1/folders lists the folders of the scope (`mine`, `shared` with the caller, or `all`) with the number of bookmarks filed in each and, for a
// folder of the caller's, how it is shared (`shareSummary`), for another member's, who owns it (`owner`), optionally those whose name contains `q`,
// sorted by name, by that number or by the time of the last change, in pages of at most 100 that the `nextCursor` resumes (doc 04
// section 6.1). The cursor is the sort key and identifier of the last item, signed with a subkey derived from the session secret for this
// list, over the account, the workspace, the scope, the search and the sort it was issued for: a forged, altered or mismatched cursor is
// `400 bad_request`. `total` counts the matching folders up to 10 000 and is null above, with `totalAtLeast` (Q42).
//
// GET and PATCH answer the folder's version in the body and as `ETag`. PATCH is a JSON Merge Patch of the name, the icon and the colour;
// `If-Match` is compared with the version under the folder's row lock and a mismatch is `412 precondition_failed` with nothing written;
// without the header the patch applies (an API token may leave it out). A patch that changes nothing answers 200 with the unchanged `ETag`.
//
// POST and DELETE /api/v1/folders/{id}/bookmarks (doc 04 section 10.7, doc 02 sections 7.1 and 8.2, doc 13 Q22, doc 10 T1 and T2) file bookmarks in
// the folder and take them out of it. Only the owner files: the caller must own the folder and every bookmark named (doc 04 says "visible to the
// caller" for the read operations, which the ownership rule of doc 02 section 8.2 and Q22 narrows), and another member's folder or bookmark, one
// of another workspace, a plan-archived bookmark (to file) and one that does not exist are the same `404 not_found` with none of the bookmarks
// filed. The request is one transaction, all or nothing, and repeating it changes nothing. Both answer 200 with the folder and its count.

const NO_WORKSPACE = "No such resource.";
const NO_SUCH_FOLDER = "No such resource.";
const SHARED_READ_ONLY = "This folder or bookmark is shared with you, and a share gives read access only.";
const NAME_TAKEN = "You already have a folder with this name.";
const NAME_INVALID = "A folder name has 1 to 64 characters.";
const STALE_VERSION = "The folder has changed since it was read; read it again and retry.";
const BAD_CURSOR = "The cursor is not valid.";
const NAME_FIELD_CODES = { empty: "too_small", too_long: "too_big" } as const;

function tenantOf(context: ChainContext): RequestTenant {
  const tenant = context.get("tenant");
  if (tenant === undefined) {
    throw new ProblemError("not_found", NO_WORKSPACE);
  }
  return tenant;
}

/** A statement that met another folder's name at the key of the table ended its transaction with nothing written; that is the answer `name_taken`. */
function nameTakenWhen(error: unknown): { readonly kind: "name_taken" } {
  if (isFolderNameTaken(error)) {
    return { kind: "name_taken" };
  }
  throw error;
}

function folderCursors(secret: string): FolderCursors {
  const codec = createPageCursorCodec(secret, "folders");
  return {
    seal: (position, scope) => codec.encodeKey([position.count === undefined ? null : String(position.count), position.updated ?? null, position.name, position.id], scope),
    open(cursor, scope) {
      const key = codec.decodeKey(cursor, scope);
      const [count, updated, name, id, ...rest] = key ?? [];
      if (key === undefined || rest.length > 0 || count === undefined || updated === undefined || typeof name !== "string" || typeof id !== "string") {
        return undefined;
      }
      if (count !== null && !/^\d{1,15}$/.test(count)) {
        return undefined;
      }
      return { count: count === null ? undefined : Number(count), updated: updated ?? undefined, name, id };
    },
  };
}

function folderBody(folder: FolderRecord): z.input<typeof FolderSchema> {
  return {
    id: folder.id,
    ownerId: folder.ownerId,
    owner: folder.owner,
    shareSummary: folder.shareSummary === null ? null : { memberCount: folder.shareSummary.memberCount, teams: folder.shareSummary.teams.map(({ id, name }) => ({ id, name })) },
    name: folder.name,
    icon: folder.icon,
    color: folder.color,
    bookmarkCount: folder.bookmarkCount,
    version: folder.version,
    createdAt: folder.createdAt.toISOString(),
    updatedAt: folder.updatedAt.toISOString(),
  };
}

export interface FolderRoutesOptions {
  /** The server secret the list cursors are signed with, through a key derived for this list alone. */
  readonly cursorSecret: string;
}

export function folderRoutes({ cursorSecret }: FolderRoutesOptions): RouteBinding[] {
  const cursors = folderCursors(cursorSecret);
  return [
    route(createFolderOperation).handle(async ({ body }, context) => {
      const tenant = tenantOf(context);
      const outcome = await tenant
        .withTenant((tx) => createFolder({ store: folderRepository(tx), newId: uuidv7 }, { accountId: tenant.accountId, name: body.name, icon: body.icon, color: body.color }))
        .catch(nameTakenWhen);
      switch (outcome.kind) {
        case "created":
          return { status: 201, body: folderBody(outcome.folder) };
        case "invalid_name":
          throw new ProblemError("validation_failed", NAME_INVALID, { errors: [{ path: "name", code: NAME_FIELD_CODES[outcome.reason] }] });
        case "name_taken":
          throw new ProblemError("name_taken", NAME_TAKEN, { errors: [{ path: "name", code: "name_taken" }] });
      }
    }),

    route(listFoldersOperation).handle(async ({ query }, context) => {
      const tenant = tenantOf(context);
      const outcome = await tenant.withTenant((tx) =>
        listFolders(
          { store: folderRepository(tx), cursors },
          { workspaceId: tenant.workspaceId, accountId: tenant.accountId, scope: query.scope, search: query.q, sort: query.sort, limit: query.limit, cursor: query.cursor },
        ),
      );
      if (outcome.kind === "bad_cursor") {
        throw new ProblemError("bad_request", BAD_CURSOR);
      }
      return {
        status: 200,
        body: {
          items: outcome.items.map(folderBody),
          nextCursor: outcome.nextCursor,
          total: outcome.total,
          ...(outcome.total === null ? { totalAtLeast: FOLDER_LIST_TOTAL_CAP } : {}),
        },
      };
    }),

    route(getFolderOperation).handle(async ({ params }, context) => {
      const tenant = tenantOf(context);
      const folder = await tenant.withTenant((tx) => readFolder({ store: folderRepository(tx) }, { folderId: params.id, accountId: tenant.accountId }));
      if (folder === undefined) {
        throw new ProblemError("not_found", NO_SUCH_FOLDER);
      }
      return { status: 200, body: folderBody(folder), headers: { ETag: entityTagOf(folder.version) } };
    }),

    route(updateFolderOperation).handle(async ({ params, body }, context) => {
      const tenant = tenantOf(context);
      const expectedVersions = acceptedVersions(context.req.header("if-match"));
      const outcome = await tenant
        .withTenant((tx) => updateFolder({ store: folderRepository(tx) }, { folderId: params.id, accountId: tenant.accountId, patch: body, expectedVersions }))
        .catch(nameTakenWhen);
      switch (outcome.kind) {
        case "updated":
        case "unchanged":
          return { status: 200, body: folderBody(outcome.folder), headers: { ETag: entityTagOf(outcome.folder.version) } };
        case "invalid_name":
          throw new ProblemError("validation_failed", NAME_INVALID, { errors: [{ path: "name", code: NAME_FIELD_CODES[outcome.reason] }] });
        case "name_taken":
          throw new ProblemError("name_taken", NAME_TAKEN, { errors: [{ path: "name", code: "name_taken" }] });
        case "stale":
          throw new ProblemError("precondition_failed", STALE_VERSION);
        case "forbidden":
          throw new ProblemError("forbidden", SHARED_READ_ONLY);
        case "not_found":
          throw new ProblemError("not_found", NO_SUCH_FOLDER);
      }
    }),

    route(addFolderBookmarksOperation).handle(async ({ params, body }, context) => {
      const tenant = tenantOf(context);
      const outcome = await tenant.withTenant((tx) => fileBookmarks({ store: folderRepository(tx) }, { folderId: params.id, accountId: tenant.accountId, bookmarkIds: body.bookmarkIds }));
      if (outcome.kind === "forbidden") {
        throw new ProblemError("forbidden", SHARED_READ_ONLY);
      }
      if (outcome.kind === "not_found") {
        throw new ProblemError("not_found", NO_SUCH_FOLDER);
      }
      return { status: 200, body: folderBody(outcome.folder), headers: { ETag: entityTagOf(outcome.folder.version) } };
    }),

    route(removeFolderBookmarksOperation).handle(async ({ params, body }, context) => {
      const tenant = tenantOf(context);
      const outcome = await tenant.withTenant((tx) => unfileBookmarks({ store: folderRepository(tx) }, { folderId: params.id, accountId: tenant.accountId, bookmarkIds: body.bookmarkIds }));
      if (outcome.kind === "forbidden") {
        throw new ProblemError("forbidden", SHARED_READ_ONLY);
      }
      if (outcome.kind === "not_found") {
        throw new ProblemError("not_found", NO_SUCH_FOLDER);
      }
      return { status: 200, body: folderBody(outcome.folder), headers: { ETag: entityTagOf(outcome.folder.version) } };
    }),

    route(deleteFolderOperation).handle(async ({ params }, context) => {
      const tenant = tenantOf(context);
      const outcome = await tenant.withTenant((tx) => deleteFolder({ store: folderRepository(tx) }, { folderId: params.id, accountId: tenant.accountId }));
      if (outcome.kind === "forbidden") {
        throw new ProblemError("forbidden", SHARED_READ_ONLY);
      }
      if (outcome.kind === "not_found") {
        throw new ProblemError("not_found", NO_SUCH_FOLDER);
      }
      return { status: 204 };
    }),
  ];
}
