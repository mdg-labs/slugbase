import type { AuditWriter } from "../audit/writer.ts";
import { withEntitlementChange, type EntitlementVersionWriter } from "../entitlements/engine.ts";

// Archiving and restoring bookmarks (doc 01 sections 7.5 and 13.3, doc 02 section 5.6, doc 05 sections 2.2 and 2.4, doc 10 T1
// and T11). A composition that limits the bookmarks of a plan calls these from its own job; CE never does, and neither service
// chooses which bookmarks to archive. Both run in the tenant transaction the caller already holds and open none, so the
// archive state, the workspace's `bookmark_count` (the bookmarks that are not archived), its `entitlement_version` and the one
// audit event with the count change together or not at all. An archived bookmark leaves the product's queries and counts, stays
// in the export flagged and is deleted by its owner like any other.

/** A tenant transaction opened with a workspace, as the archive services use it. */
export interface BookmarkArchiveTransaction {
  /** The workspace the transaction acts in. */
  readonly workspaceId: string | undefined;
  /**
   * Sets (`archived`) or clears the archive state of the bookmarks of the workspace of the transaction whose state differs,
   * adjusts the workspace's `bookmark_count` by those rows and answers how many rows changed; undefined, writing nothing, when
   * the workspace cannot be reached (it is being deleted, or the account of the transaction is no member of it). An identifier
   * that names no bookmark of the workspace is skipped. It does not raise the entitlement version: the services do, through
   * `entitlementVersion`.
   */
  setArchived(request: { readonly bookmarkIds: readonly string[]; readonly archived: boolean }): Promise<number | undefined>;
  /** Raises the workspace's `entitlement_version` in the same transaction; the services call it once per change, so a caller never wraps them in `withEntitlementChange`. */
  readonly entitlementVersion: EntitlementVersionWriter;
  /** Writes the audit event in the same transaction. */
  readonly audit: AuditWriter;
}

export interface BookmarkArchiveRequest {
  /** The workspace whose bookmarks change; it must be the one the transaction acts in. */
  readonly workspaceId: string;
  /** The bookmarks to change. One that does not belong to the workspace, is not an identifier, or is in the wanted state already changes nothing. */
  readonly bookmarkIds: readonly string[];
}

/** Thrown when the workspace of the request is not one the transaction can change, which leaves the transaction to roll back. */
export class BookmarkArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BookmarkArchiveError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function setArchived(tx: BookmarkArchiveTransaction, request: BookmarkArchiveRequest, archived: boolean): Promise<number> {
  const workspaceId = request.workspaceId.toLowerCase();
  if (tx.workspaceId === undefined || tx.workspaceId.toLowerCase() !== workspaceId) {
    throw new BookmarkArchiveError("the transaction does not act in the workspace of the request");
  }
  const bookmarkIds = [...new Set(request.bookmarkIds.filter((id) => UUID.test(id)).map((id) => id.toLowerCase()))];
  const changed = await withEntitlementChange(tx.entitlementVersion, async () => {
    const count = await tx.setArchived({ bookmarkIds, archived });
    if (count === undefined) {
      throw new BookmarkArchiveError("the workspace cannot be reached");
    }
    return count;
  });
  await tx.audit.write({
    action: archived ? "bookmark.archived" : "bookmark.restored",
    workspaceId,
    actor: { type: "system", label: "system" },
    metadata: { count: String(changed) },
    ipPrefix: null,
  });
  return changed;
}

/**
 * Archives the bookmarks of the workspace named by `request.bookmarkIds`: sets their `plan_archived_at`, lowers the workspace's
 * `bookmark_count` by the number that were not archived already, raises its `entitlement_version` and writes one
 * `bookmark.archived` audit event with that number. Repeating a call changes no bookmark and still raises the version and writes
 * its event with a count of zero.
 */
export async function archiveBookmarks(tx: BookmarkArchiveTransaction, request: BookmarkArchiveRequest): Promise<{ readonly archived: number }> {
  return { archived: await setArchived(tx, request, true) };
}

/** The reverse of `archiveBookmarks`: clears `plan_archived_at`, raises the count by the bookmarks that were archived and writes one `bookmark.restored` event. */
export async function restoreBookmarks(tx: BookmarkArchiveTransaction, request: BookmarkArchiveRequest): Promise<{ readonly restored: number }> {
  return { restored: await setArchived(tx, request, false) };
}
