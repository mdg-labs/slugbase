import type { EntitlementService } from "../entitlements/engine.ts";
import type { EntitlementLimit } from "../entitlements/catalog.ts";

// What creating a bookmark asks of the workspace-scoped entitlement `bookmarks.max` (doc 01 section 7.5, doc 10 T11): the
// ceiling itself, which a flag check cannot say. The count it is compared with is `workspaces.bookmark_count`, taken under
// the workspace's row lock in the transaction that inserts the bookmark; this reads only the ceiling, before that
// transaction opens, so no call to the entitlement source is made while the lock is held.

export interface BookmarkEntitlements {
  /**
   * The workspace's `bookmarks.max` for a member of it; undefined when the workspace cannot be seen (it does not exist, is
   * being deleted or the account is no member). A failing source rejects, so a creation is refused with an error and never
   * granted without a ceiling.
   */
  limit(accountId: string, workspaceId: string, request: object): Promise<EntitlementLimit | undefined>;
}

export function createBookmarkEntitlements(service: EntitlementService): BookmarkEntitlements {
  return {
    async limit(accountId, workspaceId, request) {
      return (await service.forRequest(request, accountId).forWorkspace(workspaceId))?.values["bookmarks.max"];
    },
  };
}
