import type { TestDatabase } from "../../src/testing.ts";
import { asSystem, freshId } from "./auth-fixture.ts";

// Teams and shares for the tests, written as slugbase_system, which bypasses the policies that otherwise confine a share to the owner of what it names.

/** A team of the workspace with the given members; answers its identifier. */
export async function seedTeam(database: TestDatabase, workspaceId: string, memberIds: readonly string[]): Promise<string> {
  const id = freshId();
  await asSystem(database, async (tx) => {
    await tx`INSERT INTO teams (id, workspace_id, name) VALUES (${id}, ${workspaceId}, ${`Team ${id}`})`;
    for (const accountId of memberIds) {
      await tx`INSERT INTO team_members (workspace_id, team_id, account_id) VALUES (${workspaceId}, ${id}, ${accountId})`;
    }
  });
  return id;
}

export interface ShareTarget {
  readonly accountId?: string;
  readonly teamId?: string;
}

/** Shares one bookmark with a member or a team. */
export async function shareBookmark(database: TestDatabase, workspaceId: string, bookmarkId: string, grantedBy: string, target: ShareTarget): Promise<void> {
  await asSystem(
    database,
    (tx) => tx`
      INSERT INTO bookmark_shares (id, workspace_id, bookmark_id, target_account_id, target_team_id, granted_by)
      VALUES (${freshId()}, ${workspaceId}, ${bookmarkId}, ${target.accountId ?? null}, ${target.teamId ?? null}, ${grantedBy})`,
  );
}

/** Files the bookmark in a new folder of `ownerId` and shares the folder with a member or a team; answers the folder. */
export async function shareThroughFolder(database: TestDatabase, workspaceId: string, bookmarkId: string, ownerId: string, target: ShareTarget): Promise<string> {
  const folderId = freshId();
  await asSystem(database, async (tx) => {
    await tx`INSERT INTO folders (id, workspace_id, owner_id, name) VALUES (${folderId}, ${workspaceId}, ${ownerId}, ${`Folder ${folderId}`})`;
    await tx`INSERT INTO folder_bookmarks (workspace_id, folder_id, bookmark_id) VALUES (${workspaceId}, ${folderId}, ${bookmarkId})`;
    await tx`
      INSERT INTO folder_shares (id, workspace_id, folder_id, target_account_id, target_team_id, granted_by)
      VALUES (${freshId()}, ${workspaceId}, ${folderId}, ${target.accountId ?? null}, ${target.teamId ?? null}, ${ownerId})`;
  });
  return folderId;
}
