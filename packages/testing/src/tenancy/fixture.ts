// The two-workspace fixture of the cross-tenant matrix (doc 08 section 3.3):
// workspaces A and B, each with an owner, an admin and a member, a team, shared
// and unshared content, slugs, invitations and tokens. This is the interface
// the matrix runs against; the probe implementation in ./probe.ts covers one
// test-only table, and the implementations over the real tables arrive with
// the tables.

export type PrincipalRole = "owner" | "admin" | "member";

/** What a fixture holds identifiers of; a path parameter is mapped to one of these. */
export const IDENTIFIER_KINDS = [
  "workspace",
  "member",
  "team",
  "bookmark",
  "folder",
  "tag",
  "slug",
  "invitation",
  "token",
] as const;
export type IdentifierKind = (typeof IDENTIFIER_KINDS)[number];

export interface FixturePrincipal {
  readonly role: PrincipalRole;
  readonly accountId: string;
  /** What the request function turns into a session or token for this principal; opaque to the matrix. */
  readonly credentials: string;
}

export type TokenScope = "read" | "read-write";

/** An API token of an account of the workspace, bound to that workspace and acting with the account's role in it. */
export interface FixtureToken extends FixturePrincipal {
  readonly scope: TokenScope;
}

export function isFixtureToken(principal: FixturePrincipal): principal is FixtureToken {
  return "scope" in principal;
}

export interface FixtureIdentifier {
  readonly kind: IdentifierKind;
  /** The value a path parameter takes: an id, or a slug for the `slug` kind. */
  readonly id: string;
  /** Set on content (bookmarks, folders, tags) so that shared and unshared rows are both targeted. */
  readonly visibility?: "shared" | "unshared";
}

export interface WorkspaceFixture {
  readonly id: string;
  readonly owner: FixturePrincipal;
  readonly admin: FixturePrincipal;
  readonly member: FixturePrincipal;
  /**
   * API tokens bound to the workspace, one for each role and scope the fixture
   * covers. The API mode of the matrix sends them beside the sessions of the
   * three principals; a fixture with none leaves the matrix to sessions.
   */
  readonly tokens?: readonly FixtureToken[];
  /** Every identifier the workspace holds. */
  readonly identifiers: readonly FixtureIdentifier[];
  /** Strings only this workspace's content contains (titles, labels), so a response that quotes them is a leak. */
  readonly markers: readonly string[];
}

export interface TenantFixture {
  readonly a: WorkspaceFixture;
  readonly b: WorkspaceFixture;
  /**
   * A checksum over every row of the workspace in every table the fixture
   * covers. It is read as the table owner, outside any request, so that a
   * change to B is seen whatever the request path did.
   */
  checksum(workspaceId: string): Promise<string>;
}

export function principalsOf(workspace: WorkspaceFixture): readonly FixturePrincipal[] {
  return [workspace.owner, workspace.admin, workspace.member];
}

export function tokensOf(workspace: WorkspaceFixture): readonly FixtureToken[] {
  return workspace.tokens ?? [];
}

export function identifiersOf(workspace: WorkspaceFixture, kind: IdentifierKind): readonly FixtureIdentifier[] {
  return workspace.identifiers.filter((identifier) => identifier.kind === kind);
}

/** Everything that names workspace B or its content: its id, its identifiers, its principals and its markers. */
export function namesOf(workspace: WorkspaceFixture): readonly string[] {
  return [
    workspace.id,
    ...workspace.identifiers.map((identifier) => identifier.id),
    ...principalsOf(workspace).map((principal) => principal.accountId),
    ...workspace.markers,
  ];
}
