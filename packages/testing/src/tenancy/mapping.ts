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
 *   `hasSlug` of `listBookmarks` and `listBookmarkIds` and the body inputs `ids[]` and `filter.hasSlug` of `bulkBookmarks` and `previewBulkBookmarks`.
 *   `hasSlug` is a flag, not an identifier, but the classifier selects every name ending in `Slug`, so it is mapped like the others. The same holds for the body input `slug`
 *   of `createBookmark` and `updateBookmark`, which is the slug the caller gives the bookmark, and for the query parameter `slug` of `checkSlugAvailability`, which is the slug
 *   the caller asks about: none of the three refers to a row, so each is mapped to a bookmark and is judged together with the inputs of the same call that do refer to one. The query
 *   parameter `bookmarkId` of `checkSlugAvailability` names the caller's bookmark and takes a bookmark identifier. A bookmark of B in that parameter, in the `folderIds` or `tagIds` of a
 *   creation or in the path of a change is answered 404 before the slug is looked at, which is what the matrix expects of the call.
 * - Slug: the body input `slug` of `resolveSlug` and of `chooseSlug` is the handle the caller resolves and not the identifier of a row, so the default maps it to a bookmark like the
 *   other inputs named slug, which the default fixture holds. A fixture that holds the slugs of the forwarding bookmarks of workspace B (kind `slug`), which the caller has no bookmark of, maps
 *   it to `slug` and holds that a slug of B resolves to nothing for the caller. The body input `bookmarkId` of `chooseSlug` takes a bookmark identifier, and the choice of a bookmark of B is
 *   `404 slug_not_found`. `resolveSlug` answers an empty `200` and not `404` for a slug of B, which `runApiMatrix` is told by its `emptyAnswers` option. The path parameter `slug` of
 *   `deleteGoPreference` is a slug as well, and the default maps it to a bookmark; a fixture that holds the slugs of workspace B maps it to `slug`, and forgetting a slug of B, which the owner of B
 *   has a remembered choice for and the caller has none, is `404 not_found` and leaves the choice of B as it was. `listGoPreferences` has no identifier input.
 * - Host: the path parameter `host` of `getFavicon` is the host name of a bookmark, a handle the caller writes and not the identifier of a row, so the default maps it to a bookmark (an
 *   identifier of the default fixture is a valid host name, which is all the operation reads). A fixture that holds the hosts of the bookmarks of workspace B (kind `host`), which the caller has no
 *   bookmark on, maps it to `host` and holds that a host of B is answered the placeholder, queues no fetch and names nothing of B. `getFavicon` answers `202` and not `404` for such a host, which
 *   `runApiMatrix` is told by its `emptyAnswers` option.
 * - Tag identifier: the path parameter `id` of `renameTag`, `mergeTag` and `deleteTag`, the body input `intoTagId` of `mergeTag`, the query parameter `tag` of `listBookmarks` and `listBookmarkIds` (as a single value and as a repeated one), the body input `filter.tag` of `bulkBookmarks` and
 *   `previewBulkBookmarks` (as a single value and as a list) and the body input `tagIds[]` of `createBookmark`, `updateBookmark`, `bulkBookmarks` and `previewBulkBookmarks`. The body input `tagNames[]` of the two is a name, not an identifier, and takes no entry.
 * - Folder identifier: the path parameter `id` of `getFolder`, `updateFolder`, `deleteFolder`, `addFolderBookmarks` and `removeFolderBookmarks`, the query
 *   parameter `folderId` of `listBookmarks` and `listBookmarkIds`, the body inputs `folderId` and `filter.folderId` of `bulkBookmarks` (the second also of `previewBulkBookmarks`) and the body input `folderIds[]` of `createBookmark` and `updateBookmark`. The body input `bookmarkIds[]` of
 *   `addFolderBookmarks` and `removeFolderBookmarks` takes a bookmark identifier.
 * - Member identifier (an account): `accountId` of `removeMember`, `updateMember` and `transferWorkspaceOwnership`, and `transferTo` of
 *   `removeMember` and `leaveWorkspace`.
 * - Team identifier: `teamIds[]` of `createInvitation`, and the path parameter `id` of `getTeam`, `updateTeam`, `deleteTeam` and `replaceTeamMembers`. The body input
 *   `accountIds[]` of `replaceTeamMembers` takes a member identifier (an account).
 * - Invitation identifier: the path parameter `id` of `revokeInvitation`, `createInvitationLink` and `resendInvitation`.
 *
 * Entries are keyed by operation, because the name `id` takes a bookmark in one operation and an invitation in another. The fixture the matrix
 * runs against must hold identifiers of workspace B of every kind it is mapped to: the default fixture of `createProbe` holds `member` and
 * `bookmark` rows, so a caller that runs these operations adds `team` and `invitation` identifiers to workspace B, or the matrix reports
 * `no_target`. A test over the committed `openapi.json` fails when a tenant-scoped operation has an input without an entry here.
 */
export const PATH_PARAMETER_MAPPING: PathParameterMapping = {
  "getBookmark.id": "bookmark",
  "createBookmark.slug": "bookmark",
  "updateBookmark.slug": "bookmark",
  "checkSlugAvailability.slug": "bookmark",
  "checkSlugAvailability.bookmarkId": "bookmark",
  "resolveSlug.slug": "bookmark",
  "chooseSlug.slug": "bookmark",
  "chooseSlug.bookmarkId": "bookmark",
  "deleteGoPreference.slug": "bookmark",
  "getFavicon.host": "bookmark",
  "updateBookmark.id": "bookmark",
  "deleteBookmark.id": "bookmark",
  "openBookmark.id": "bookmark",
  "renameTag.id": "tag",
  "deleteTag.id": "tag",
  "mergeTag.id": "tag",
  "mergeTag.intoTagId": "tag",
  "getFolder.id": "folder",
  "updateFolder.id": "folder",
  "deleteFolder.id": "folder",
  "addFolderBookmarks.id": "folder",
  "removeFolderBookmarks.id": "folder",
  "addFolderBookmarks.bookmarkIds[]": "bookmark",
  "removeFolderBookmarks.bookmarkIds[]": "bookmark",
  "listBookmarks.folderId": "folder",
  "listBookmarks.tag": "tag",
  "listBookmarks.tag[]": "tag",
  "createBookmark.tagIds[]": "tag",
  "updateBookmark.tagIds[]": "tag",
  "createBookmark.folderIds[]": "folder",
  "updateBookmark.folderIds[]": "folder",
  "listBookmarks.hasSlug": "bookmark",
  "listBookmarkIds.hasSlug": "bookmark",
  "listBookmarkIds.folderId": "folder",
  "listBookmarkIds.tag": "tag",
  "listBookmarkIds.tag[]": "tag",
  "bulkBookmarks.ids[]": "bookmark",
  "bulkBookmarks.filter.hasSlug": "bookmark",
  "bulkBookmarks.filter.folderId": "folder",
  "bulkBookmarks.filter.tag": "tag",
  "bulkBookmarks.filter.tag[]": "tag",
  "bulkBookmarks.folderId": "folder",
  "bulkBookmarks.tagIds[]": "tag",
  "previewBulkBookmarks.ids[]": "bookmark",
  "previewBulkBookmarks.filter.hasSlug": "bookmark",
  "previewBulkBookmarks.filter.folderId": "folder",
  "previewBulkBookmarks.filter.tag": "tag",
  "previewBulkBookmarks.filter.tag[]": "tag",
  "previewBulkBookmarks.tagIds[]": "tag",
  "createInvitation.teamIds[]": "team",
  "getTeam.id": "team",
  "updateTeam.id": "team",
  "deleteTeam.id": "team",
  "replaceTeamMembers.id": "team",
  "replaceTeamMembers.accountIds[]": "member",
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
 * touch every folder of A that the policy shows, and the update gives them all one name. A link is the owner's, on both sides: the policies of
 * `folder_bookmarks` admit a link whose folder and bookmark are the account's own, so the links sample names a folder (`...a0d2`) and a bookmark
 * (`...a0b2`) that the owner of A owns in A, with no link between them yet; the repository has no update, so its `set` is empty. The fixture must
 * hold that folder and bookmark, and another bookmark of the same owner linked to the folder, which the delete of the registry removes; B holds a
 * folder, a bookmark and a link of its own that the methods must not reach. The links of the tags follow the same rule, with the tag in place of the
 * folder: the `bookmark_tags` sample names the tag of the owner of A (`...a0c1`) and a bookmark (`...a0b4`) that the owner owns in A, with no link between them yet, and
 * the fixture must hold the tag and the bookmark and another bookmark of that owner linked to the tag, which the delete of the registry removes; B holds the same of its own.
 * A remembered choice is its member's own in the workspace: the `slug_preferences` sample names the owner of A and a bookmark (`...a0b2`) of that owner's in A, and its update points
 * the preference at another bookmark of the owner's (`...a0b3`); the fixture must hold a preference of the owner of A in A, which the update touches, and one of the owner of B in B, which the
 * methods must not reach. The policy names the account of the transaction too, so the owner of A sees its own preferences only.
 * The cache of page metadata is the workspace's: the `url_metadata` repository has the three methods the application role may run on the table (it reads, inserts a row and
 * updates the columns of a result, and deletes none), the sample inserts a `failed` result, which holds no field, and its update sets the title, which only an `ok` row may hold, so
 * the fixture must hold an `ok` result in A for the update to touch, and one in B, which the methods must not reach.
 * A team is the workspace's and no member's: the policies of `teams` and `team_members` name the workspace only. The update and the delete of the registry have no predicate,
 * so they touch every team of A the policy shows, and the update gives them all one name: the fixture must hold exactly one team in A (and one in B, which the methods must
 * not reach). The `team_members` sample names that team (`...a0e1`) and the owner of A, who is no member of it yet; the fixture must hold another member of A in the team, which
 * the delete of the registry removes, and a team with a member of its own in B. The repository has no update, so its `set` is empty.
 */
export const REPOSITORY_SAMPLES: RepositorySamples = {
  bookmarks: {
    values: {
      id: "0192f3a0-2222-7000-8000-00000000b00c",
      url: "https://example.com/matrix",
      urlCanonical: "https://example.com/matrix",
      host: "example.com",
      title: "matrix-bookmark-inserted",
      slug: "matrix-slug",
      forwarding: true,
    },
    set: { title: "matrix-bookmark-updated" },
  },
  folders: {
    values: { id: "0192f3a0-2222-7000-8000-00000000b00e", name: "matrix-folder-inserted" },
    set: { name: "matrix-folder-updated" },
  },
  folder_bookmarks: {
    values: { folderId: "0192f3a0-2222-7000-8000-00000000a0d2", bookmarkId: "0192f3a0-2222-7000-8000-00000000a0b2" },
    set: {},
  },
  bookmark_tags: {
    values: { bookmarkId: "0192f3a0-2222-7000-8000-00000000a0b4", tagId: "0192f3a0-2222-7000-8000-00000000a0c1" },
    set: {},
  },
  slug_preferences: {
    values: (fixture) => ({ accountId: fixture.a.owner.accountId, slug: "matrix-pref", bookmarkId: "0192f3a0-2222-7000-8000-00000000a0b2" }),
    set: { bookmarkId: "0192f3a0-2222-7000-8000-00000000a0b3" },
  },
  url_metadata: {
    values: { urlCanonical: "https://example.com/matrix-metadata", status: "failed", fetchedAt: new Date("2026-01-01T00:00:00Z"), expiresAt: new Date("2026-01-08T00:00:00Z") },
    set: { title: "matrix-metadata-updated" },
  },
  teams: {
    values: { id: "0192f3a0-2222-7000-8000-00000000b00f", name: "matrix-team-inserted" },
    set: { name: "matrix-team-updated" },
  },
  team_members: {
    values: (fixture) => ({ teamId: "0192f3a0-2222-7000-8000-00000000a0e1", accountId: fixture.a.owner.accountId }),
    set: {},
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
