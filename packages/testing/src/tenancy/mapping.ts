import type { IdentifierKind, TenantFixture } from "./fixture.js";

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
  /**
   * A row an insert writes, without `workspaceId`. A function when the row names an account of the fixture (the owner of a tag): it is
   * given the fixture the matrix runs against.
   */
  readonly values: Readonly<Record<string, unknown>> | ((fixture: TenantFixture) => Readonly<Record<string, unknown>>);
  /** The columns an update sets, without `workspaceId`. */
  readonly set: Readonly<Record<string, unknown>>;
}

/** The columns of a sample's insert for the fixture the matrix runs against. */
export function sampleValues(sample: RepositorySample, fixture: TenantFixture): Readonly<Record<string, unknown>> {
  return typeof sample.values === "function" ? sample.values(fixture) : sample.values;
}

/** A repository name (as registered in the scoped-repository registry) to the sample its writes use. */
export type RepositorySamples = Readonly<Record<string, RepositorySample>>;

/**
 * The default mapping of the cross-tenant matrix: it covers every identifier-carrying input of every tenant-scoped operation of the committed
 * contract, so a run of `runApiMatrix` over `openapi.json` with no `mapping` option reports no "no mapping" for one.
 *
 * - Bookmark identifier: the path parameter `id` of `getBookmark`, `updateBookmark`, `deleteBookmark` and `openBookmark`, the query parameter
 *   `hasSlug` of `listBookmarks` and `listBookmarkIds` and the body inputs `ids[]` and `filter.hasSlug` of `bulkBookmarks`. `hasSlug` is a flag, not
 *   an identifier, but the classifier selects every name ending in `Slug`, so it is mapped like the others.
 * - Tag identifier: the path parameter `id` of `renameTag` and `deleteTag`.
 * - Folder identifier: the path parameter `id` of `getFolder`, `updateFolder` and `deleteFolder`.
 * - Member identifier (an account): `accountId` of `removeMember`, `updateMember` and `transferWorkspaceOwnership`, and `transferTo` of
 *   `removeMember` and `leaveWorkspace`.
 * - Team identifier: `teamIds[]` of `createInvitation`.
 * - Invitation identifier: the path parameter `id` of `revokeInvitation`, `createInvitationLink` and `resendInvitation`.
 *
 * Entries are keyed by operation, because the name `id` takes a bookmark in one operation and an invitation in another. The fixture the matrix
 * runs against must hold identifiers of workspace B of every kind it is mapped to: the default fixture of `createProbe` holds `member` and
 * `bookmark` rows, so a caller that runs these operations adds `team` and `invitation` identifiers to workspace B, or the matrix reports
 * `no_target`. A test over the committed `openapi.json` fails when a tenant-scoped operation has an input without an entry here.
 */
export const PATH_PARAMETER_MAPPING: PathParameterMapping = {
  "getBookmark.id": "bookmark",
  "updateBookmark.id": "bookmark",
  "deleteBookmark.id": "bookmark",
  "openBookmark.id": "bookmark",
  "renameTag.id": "tag",
  "deleteTag.id": "tag",
  "getFolder.id": "folder",
  "updateFolder.id": "folder",
  "deleteFolder.id": "folder",
  "listBookmarks.hasSlug": "bookmark",
  "listBookmarkIds.hasSlug": "bookmark",
  "bulkBookmarks.ids[]": "bookmark",
  "bulkBookmarks.filter.hasSlug": "bookmark",
  "createInvitation.teamIds[]": "team",
  "revokeInvitation.id": "invitation",
  "createInvitationLink.id": "invitation",
  "resendInvitation.id": "invitation",
  "removeMember.accountId": "member",
  "removeMember.transferTo": "member",
  "updateMember.accountId": "member",
  "leaveWorkspace.transferTo": "member",
  "transferWorkspaceOwnership.accountId": "member",
};

/**
 * The columns the RLS-only mode writes to each scoped repository of `@slugbase/db`. The bookmarks repository updates the columns of a request
 * only, so its update sample sets the title; the row of an insert has no owner, which keeps the sample independent of the membership rows of the
 * fixture. The bookmarks repository has no delete: a delete is the system operation `sys_bookmark_delete`, which the API mode exercises. A tag is
 * its owner's, so the tags sample names the owner of workspace A of the fixture, the account the RLS-only mode acts as; the fixture must hold a
 * tag of that owner in A for the update and the delete to touch a row. The policies of `folders` name the workspace only, so the row of a folder's
 * insert has no owner either, and the fixture must hold one folder in A: the update and the delete of the registry have no predicate, so they
 * touch every folder of A that the policy shows, and the update gives them all one name.
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
  folders: {
    values: { id: "0192f3a0-2222-7000-8000-00000000b00e", name: "matrix-folder-inserted" },
    set: { name: "matrix-folder-updated" },
  },
  tags: {
    values: (fixture) => ({ id: "0192f3a0-2222-7000-8000-00000000b00d", ownerId: fixture.a.owner.accountId, name: "matrix-tag-inserted" }),
    set: { name: "matrix-tag-updated" },
  },
};

export function kindOfParameter(
  mapping: PathParameterMapping,
  operationId: string,
  parameter: string,
): IdentifierKind | undefined {
  return mapping[`${operationId}.${parameter}`] ?? mapping[parameter];
}
