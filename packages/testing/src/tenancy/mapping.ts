import type { IdentifierKind } from "./fixture.js";

// The mapping file of the cross-tenant matrix (doc 08 section 3.3). An
// operation with a path parameter, or a query or body input that can carry an
// identifier (see openapi.ts), and no entry here for it fails the matrix until
// one is added, so a new operation cannot go uncovered by being unmappable.

/**
 * An input name to the kind of fixture identifier it takes: a path parameter
 * (`bookmarkId`), a query parameter (`entityId`) or a body property path
 * (`accountId`, `invitation.teamIds[]`). An entry keyed
 * `<operationId>.<name>` takes precedence over one keyed by the name alone.
 */
export type PathParameterMapping = Readonly<Record<string, IdentifierKind>>;

/** The columns the RLS-only mode writes to a repository's table. */
export interface RepositorySample {
  /** A row an insert writes, without `workspaceId`. */
  readonly values: Readonly<Record<string, unknown>>;
  /** The columns an update sets, without `workspaceId`. */
  readonly set: Readonly<Record<string, unknown>>;
}

/** A repository name (as registered in the scoped-repository registry) to the sample its writes use. */
export type RepositorySamples = Readonly<Record<string, RepositorySample>>;

/**
 * The inputs of the committed contract that carry the identifier of a bookmark: the path parameter `id` of `getBookmark`, `updateBookmark`,
 * `deleteBookmark` and `openBookmark`, the query parameter `hasSlug` of `listBookmarks` and `listBookmarkIds` and the body inputs `ids[]` and
 * `filter.hasSlug` of `bulkBookmarks`. `hasSlug` is a flag, not an identifier, but the classifier selects every name ending in `Slug`, so it is
 * mapped like the others. The other tenant-scoped operations that take an identifier (a member, a team, an invitation) are mapped by the
 * suites that hold a fixture with those rows. A test over the committed `openapi.json` fails when a bookmark operation has an input without an
 * entry here.
 */
export const PATH_PARAMETER_MAPPING: PathParameterMapping = {
  "getBookmark.id": "bookmark",
  "updateBookmark.id": "bookmark",
  "deleteBookmark.id": "bookmark",
  "openBookmark.id": "bookmark",
  "listBookmarks.hasSlug": "bookmark",
  "listBookmarkIds.hasSlug": "bookmark",
  "bulkBookmarks.ids[]": "bookmark",
  "bulkBookmarks.filter.hasSlug": "bookmark",
};

/**
 * The columns the RLS-only mode writes to each scoped repository of `@slugbase/db`. The bookmarks repository updates the columns of a request
 * only, so its update sample sets the title; the row of an insert has no owner, which keeps the sample independent of the membership rows of the
 * fixture. The bookmarks repository has no delete: a delete is the system operation `sys_bookmark_delete`, which the API mode exercises.
 */
export const REPOSITORY_SAMPLES: RepositorySamples = {
  bookmarks: {
    values: {
      id: "0192f3a0-2222-7000-8000-00000000b00c",
      url: "https://example.com/matrix",
      urlCanonical: "https://example.com/matrix",
      host: "example.com",
      title: "matrix-bookmark-inserted",
    },
    set: { title: "matrix-bookmark-updated" },
  },
};

export function kindOfParameter(
  mapping: PathParameterMapping,
  operationId: string,
  parameter: string,
): IdentifierKind | undefined {
  return mapping[`${operationId}.${parameter}`] ?? mapping[parameter];
}
