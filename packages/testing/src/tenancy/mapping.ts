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

// Phase 1 declares no tenant-scoped operation and registers no scoped
// repository, so there is nothing to map yet.
export const PATH_PARAMETER_MAPPING: PathParameterMapping = {};
export const REPOSITORY_SAMPLES: RepositorySamples = {};

export function kindOfParameter(
  mapping: PathParameterMapping,
  operationId: string,
  parameter: string,
): IdentifierKind | undefined {
  return mapping[`${operationId}.${parameter}`] ?? mapping[parameter];
}
