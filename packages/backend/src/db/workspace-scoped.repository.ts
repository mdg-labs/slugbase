import { ForbiddenException, NotFoundException } from "@nestjs/common";

import type { DrizzleClient } from "./dialect/create-client.js";

/**
 * Marker interface for any DB record that belongs to a workspace.
 *
 * Every workspace-scoped table record (bookmark, folder, slug, tag, …) must
 * implement this interface so that `WorkspaceScopedRepository` can enforce
 * isolation at the type level.
 */
export interface WorkspaceOwned {
  workspaceId: string;
}

/**
 * Abstract base class for all workspace-scoped Drizzle repositories.
 *
 * Every repository that touches workspace-scoped data (bookmarks, folders,
 * slugs, tags, …) MUST extend this class. It enforces two isolation rules:
 *
 *   1. **Query-level scoping** — every public method on a subclass must accept
 *      `workspaceId` as an explicit first parameter, and every SELECT/UPDATE/
 *      DELETE query must include `.where(eq(table.workspaceId, workspaceId))`.
 *      There is no way to call a scoped repository without providing a
 *      `workspaceId`, making cross-workspace data access structurally
 *      prevented.
 *
 *   2. **Return-value verification** — before returning any DB record to the
 *      caller, subclasses must call `assertOwnership` (single record) or
 *      `assertAllOwned` (list). This is a defence-in-depth check that catches
 *      any record that slipped through a mis-scoped query.
 *
 * ### Subclass contract
 *
 * - Accept `workspaceId` as the first positional arg in every public method.
 * - Add `.where(eq(table.workspaceId, workspaceId))` to every SELECT/UPDATE/
 *   DELETE query — never omit the workspace filter.
 * - Call `assertOwnership(workspaceId, record)` on every single-record result.
 * - Call `assertAllOwned(workspaceId, records)` on every list result.
 *
 * Spec §5.9, §11.9; security baseline rule §03.
 */
export abstract class WorkspaceScopedRepository<T extends WorkspaceOwned> {
  protected constructor(protected readonly db: DrizzleClient) {}

  /**
   * Verifies that a record returned from the DB belongs to the given workspace.
   *
   * Call this after every single-record DB fetch, before returning to the caller.
   *
   * @throws {NotFoundException}  when `record` is null or undefined
   * @throws {ForbiddenException} when `record.workspaceId !== workspaceId`
   */
  protected assertOwnership(workspaceId: string, record: T | null | undefined): T {
    if (record == null) {
      throw new NotFoundException("Resource not found");
    }
    if (record.workspaceId !== workspaceId) {
      throw new ForbiddenException(
        "Resource does not belong to the active workspace",
      );
    }
    return record;
  }

  /**
   * Verifies that every record in a list belongs to the given workspace.
   *
   * Call this after every multi-record DB fetch, before returning to the caller.
   * Any record that slipped through a mis-scoped query is caught here.
   *
   * @throws {ForbiddenException} when any `record.workspaceId !== workspaceId`
   */
  protected assertAllOwned(workspaceId: string, records: T[]): T[] {
    for (const record of records) {
      if (record.workspaceId !== workspaceId) {
        throw new ForbiddenException(
          "Resource does not belong to the active workspace",
        );
      }
    }
    return records;
  }
}
