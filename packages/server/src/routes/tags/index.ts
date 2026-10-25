import { TAG_LIST_TOTAL_CAP, createTag as createTagOperation, deleteTag as deleteTagOperation, listTags as listTagsOperation, renameTag as renameTagOperation, type TagSchema } from "@slugbase/contracts";
import { createTag, deleteTag, listTags, renameTag, type TagCursors, type TagRecord } from "@slugbase/core";
import { isTagNameTaken, tagRepository } from "@slugbase/db";
import type { z } from "zod";
import { createPageCursorCodec } from "../../auth/page-cursor.ts";
import { uuidv7 } from "../../auth/uuidv7.ts";
import type { ChainContext, RouteBinding } from "../../http/chain.ts";
import { ProblemError } from "../../http/problem.ts";
import type { RequestTenant } from "../../http/tenant.ts";
import { route } from "../register.ts";

// POST, GET /api/v1/tags and PATCH, DELETE /api/v1/tags/{id} (doc 04 section 10.7, doc 02 section 7.2, doc 05 section 2.4, doc 10 T1 and
// T2). All four act in the workspace the request is bound to and name none; the authorization stage lets a member through (a session,
// or a token of the matching scope: write to create, rename and delete, read to list).
//
// A tag is its owner's alone. The policies of the table keep every other member of the workspace from reading, renaming or deleting
// it, and the statements name the owner too, so another member's tag, a tag of another workspace and one that does not exist are the
// same `404 not_found` (doc 04 section 2.4). A name is 1 to 40 characters after the whitespace around it is removed, stored as entered
// and unique per owner without regard to case: creating or renaming to a name the caller already uses on another tag is `409
// name_taken` and writes nothing (merging two tags is another operation). Deleting a tag removes its links to bookmarks, which stay; a hard
// delete keeps no tombstone, so the repeat is `404`.
//
// GET /api/v1/tags lists the caller's tags with the number of bookmarks each carries, sorted by name or by that number, in pages of at most
// 100 that the `nextCursor` resumes (doc 04 section 6.1). The cursor is the sort key and identifier of the last item, signed with a subkey
// derived from the session secret for this list, over the account, the workspace and the sort it was issued for: a forged, altered or
// mismatched cursor is `400 bad_request`. `total` counts the caller's tags up to 10 000 and is null above, with `totalAtLeast` (Q42).

const NO_WORKSPACE = "No such resource.";
const NO_SUCH_TAG = "No such resource.";
const NAME_TAKEN = "You already have a tag with this name.";
const NAME_INVALID = "A tag name has 1 to 40 characters.";
const BAD_CURSOR = "The cursor is not valid.";
const NAME_FIELD_CODES = { empty: "too_small", too_long: "too_big" } as const;

function tenantOf(context: ChainContext): RequestTenant {
  const tenant = context.get("tenant");
  if (tenant === undefined) {
    throw new ProblemError("not_found", NO_WORKSPACE);
  }
  return tenant;
}

/** A statement that met another tag's name at the key of the table ended its transaction with nothing written; that is the answer `name_taken`. */
function nameTakenWhen(error: unknown): { readonly kind: "name_taken" } {
  if (isTagNameTaken(error)) {
    return { kind: "name_taken" };
  }
  throw error;
}

function tagCursors(secret: string): TagCursors {
  const codec = createPageCursorCodec(secret, "tags");
  return {
    seal: (position, scope) => codec.encodeKey([position.count === undefined ? null : String(position.count), position.name, position.id], scope),
    open(cursor, scope) {
      const key = codec.decodeKey(cursor, scope);
      const [count, name, id, ...rest] = key ?? [];
      if (key === undefined || rest.length > 0 || count === undefined || typeof name !== "string" || typeof id !== "string") {
        return undefined;
      }
      if (count === null) {
        return { count: undefined, name, id };
      }
      return /^\d{1,15}$/.test(count) ? { count: Number(count), name, id } : undefined;
    },
  };
}

function tagBody(tag: TagRecord): z.input<typeof TagSchema> {
  return { id: tag.id, name: tag.name, bookmarkCount: tag.bookmarkCount, createdAt: tag.createdAt.toISOString() };
}

export interface TagRoutesOptions {
  /** The server secret the list cursors are signed with, through a key derived for this list alone. */
  readonly cursorSecret: string;
}

export function tagRoutes({ cursorSecret }: TagRoutesOptions): RouteBinding[] {
  const cursors = tagCursors(cursorSecret);
  return [
    route(createTagOperation).handle(async ({ body }, context) => {
      const tenant = tenantOf(context);
      const outcome = await tenant
        .withTenant((tx) => createTag({ store: tagRepository(tx), newId: uuidv7 }, { accountId: tenant.accountId, name: body.name }))
        .catch(nameTakenWhen);
      switch (outcome.kind) {
        case "created":
          return { status: 201, body: tagBody(outcome.tag) };
        case "invalid_name":
          throw new ProblemError("validation_failed", NAME_INVALID, { errors: [{ path: "name", code: NAME_FIELD_CODES[outcome.reason] }] });
        case "name_taken":
          throw new ProblemError("name_taken", NAME_TAKEN, { errors: [{ path: "name", code: "name_taken" }] });
      }
    }),

    route(listTagsOperation).handle(async ({ query }, context) => {
      const tenant = tenantOf(context);
      const outcome = await tenant.withTenant((tx) =>
        listTags(
          { store: tagRepository(tx), cursors },
          { workspaceId: tenant.workspaceId, accountId: tenant.accountId, sort: query.sort, limit: query.limit, cursor: query.cursor },
        ),
      );
      if (outcome.kind === "bad_cursor") {
        throw new ProblemError("bad_request", BAD_CURSOR);
      }
      return {
        status: 200,
        body: {
          items: outcome.items.map(tagBody),
          nextCursor: outcome.nextCursor,
          total: outcome.total,
          ...(outcome.total === null ? { totalAtLeast: TAG_LIST_TOTAL_CAP } : {}),
        },
      };
    }),

    route(renameTagOperation).handle(async ({ params, body }, context) => {
      const tenant = tenantOf(context);
      const outcome = await tenant
        .withTenant((tx) => renameTag({ store: tagRepository(tx) }, { tagId: params.id, accountId: tenant.accountId, name: body.name }))
        .catch(nameTakenWhen);
      switch (outcome.kind) {
        case "renamed":
        case "unchanged":
          return { status: 200, body: tagBody(outcome.tag) };
        case "invalid_name":
          throw new ProblemError("validation_failed", NAME_INVALID, { errors: [{ path: "name", code: NAME_FIELD_CODES[outcome.reason] }] });
        case "name_taken":
          throw new ProblemError("name_taken", NAME_TAKEN, { errors: [{ path: "name", code: "name_taken" }] });
        case "not_found":
          throw new ProblemError("not_found", NO_SUCH_TAG);
      }
    }),

    route(deleteTagOperation).handle(async ({ params }, context) => {
      const tenant = tenantOf(context);
      const deleted = await tenant.withTenant((tx) => deleteTag({ store: tagRepository(tx) }, { tagId: params.id, accountId: tenant.accountId }));
      if (!deleted) {
        throw new ProblemError("not_found", NO_SUCH_TAG);
      }
      return { status: 204 };
    }),
  ];
}
