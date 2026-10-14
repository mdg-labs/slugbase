import type { TestDatabase } from "../../src/testing.ts";
import { asSystem, freshId } from "./auth-fixture.ts";

// Workspaces and memberships for the tests, written the way the test database
// allows: both tables have forced row-level security and slugbase_app holds no
// write privilege on them, so the owner inserts as slugbase_system, which
// stands for the system operations that create them.

export type Role = "owner" | "admin" | "member";

export interface SeedWorkspace {
  readonly id?: string;
  readonly name?: string;
  readonly createdBy?: string | null;
  readonly deletingAt?: Date | null;
}

export async function seedWorkspace(database: TestDatabase, workspace: SeedWorkspace = {}): Promise<string> {
  const id = workspace.id ?? freshId();
  await asSystem(
    database,
    (tx) => tx`
      INSERT INTO workspaces (id, name, created_by, deleting_at)
      VALUES (${id}, ${workspace.name ?? "Test workspace"}, ${workspace.createdBy ?? null}, ${workspace.deletingAt ?? null})`,
  );
  return id;
}

export interface SeedMember {
  readonly workspaceId: string;
  readonly accountId: string;
  readonly role?: Role;
  readonly joinedAt?: Date;
  readonly lastActiveAt?: Date | null;
}

export async function seedMember(database: TestDatabase, member: SeedMember): Promise<void> {
  await asSystem(
    database,
    (tx) => tx`
      INSERT INTO workspace_members (workspace_id, account_id, role, joined_at, last_active_at)
      VALUES (${member.workspaceId}, ${member.accountId}, ${member.role ?? "member"}, ${member.joinedAt ?? new Date()}, ${member.lastActiveAt ?? null})`,
  );
}

/** A digest of every row of the workspace in both tables, read as slugbase_system, so a change to it is seen whatever path made it. */
export async function workspaceChecksum(database: TestDatabase, workspaceId: string): Promise<string> {
  const rows = await asSystem(
    database,
    (tx) => tx<{ digest: string }[]>`
      SELECT md5(
        coalesce((SELECT string_agg(w::text, '|' ORDER BY w.id) FROM workspaces w WHERE w.id = ${workspaceId}), '') ||
        coalesce((SELECT string_agg(m::text, '|' ORDER BY m.account_id) FROM workspace_members m WHERE m.workspace_id = ${workspaceId}), '')
      ) AS digest`,
  );
  const [row] = rows;
  if (row === undefined) {
    throw new Error("the checksum query returned no row");
  }
  return row.digest;
}
