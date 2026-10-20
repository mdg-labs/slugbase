import type { EntitlementVersionWriter } from "@slugbase/core";
import { sql } from "drizzle-orm";
import { TenantContextError, tenantHandle, type TenantTx } from "../tenant.ts";

// What the entitlement engine and `GET /entitlements` read from the database (doc 01 sections 7.5 and 8.3, doc 05
// section 2.2, doc 10 T1 and T11). Everything is read on the policies of `workspaces` and `workspace_members`
// for the workspace the transaction acts in, so a transaction acting in A neither reads nor raises B, and the
// version and the usage are read only for an account that is a member of that workspace. The
// version is raised by the system operation `sys_workspace_bump_entitlement_version`, because `slugbase_app` has
// no privilege on the column; the repository is the `EntitlementVersionWriter` of `withEntitlementChange`.

/** The counters an entitlement is compared with. */
export interface EntitlementUsage {
  /** `workspaces.bookmark_count`: the bookmarks that are not plan-archived. */
  readonly bookmarksUsed: number;
  /** The members of the workspace; a pending invitation is not one. */
  readonly seatsUsed: number;
}

export interface EntitlementRepository extends EntitlementVersionWriter {
  /**
   * The `entitlement_version` of the workspace of the transaction; undefined when the workspace cannot be seen
   * (it is being deleted or does not exist) or the account of the transaction is no member of it. Needs a
   * transaction opened with a workspace.
   */
  version(): Promise<number | undefined>;
  /** The usage counters of the workspace of the transaction; undefined when it cannot be seen or the account is no member of it. Needs a transaction opened with a workspace. */
  usage(): Promise<EntitlementUsage | undefined>;
  /**
   * How many workspaces the account of the transaction owns, without one being deleted. Works in an
   * account-level transaction.
   */
  ownedWorkspaces(): Promise<number>;
  /**
   * Raises the entitlement version of the workspace of the transaction by one through
   * `sys_workspace_bump_entitlement_version` and answers the new version; undefined, changing nothing, for a
   * workspace being deleted. Needs a transaction opened with a workspace.
   */
  bump(): Promise<number | undefined>;
}

interface VersionRow extends Record<string, unknown> {
  entitlement_version: number;
}

interface UsageRow extends Record<string, unknown> {
  bookmark_count: number;
  seat_count: string;
}

interface OwnedRow extends Record<string, unknown> {
  owned: string;
}

interface BumpedRow extends Record<string, unknown> {
  version: number | null;
}

function workspaceOf(tx: TenantTx, what: string): string {
  if (tx.workspaceId === undefined) {
    throw new TenantContextError("workspace_required", `${what} needs a tenant transaction opened with a workspace`);
  }
  return tx.workspaceId;
}

export function entitlementRepository(tx: TenantTx): EntitlementRepository {
  return {
    async version() {
      const workspaceId = workspaceOf(tx, "reading the entitlement version");
      const rows = await tenantHandle(tx).execute<VersionRow>(sql`
        SELECT entitlement_version FROM public.workspaces
        WHERE id = ${workspaceId}::uuid AND id IN (SELECT public.app_member_workspace_ids())`);
      return rows[0]?.entitlement_version;
    },

    async usage() {
      const workspaceId = workspaceOf(tx, "reading the entitlement usage");
      const rows = await tenantHandle(tx).execute<UsageRow>(sql`
        SELECT w.bookmark_count,
          (SELECT count(*) FROM public.workspace_members m WHERE m.workspace_id = w.id)::text AS seat_count
        FROM public.workspaces w
        WHERE w.id = ${workspaceId}::uuid AND w.id IN (SELECT public.app_member_workspace_ids())`);
      const row = rows[0];
      return row === undefined ? undefined : { bookmarksUsed: row.bookmark_count, seatsUsed: Number(row.seat_count) };
    },

    async ownedWorkspaces() {
      const rows = await tenantHandle(tx).execute<OwnedRow>(sql`
        SELECT count(*)::text AS owned
        FROM public.workspace_members m
        JOIN public.workspaces w ON w.id = m.workspace_id
        WHERE m.account_id = ${tx.accountId}::uuid
          AND m.role = 'owner'
          AND w.id IN (SELECT public.app_member_workspace_ids())`);
      return Number(rows[0]?.owned ?? 0);
    },

    async bump() {
      const workspaceId = workspaceOf(tx, "raising the entitlement version");
      const rows = await tenantHandle(tx).execute<BumpedRow>(sql`
        SELECT public.sys_workspace_bump_entitlement_version(${workspaceId}::uuid) AS version`);
      if (rows.length !== 1) {
        throw new Error("sys_workspace_bump_entitlement_version did not return exactly one row");
      }
      return rows[0]?.version ?? undefined;
    },
  };
}
