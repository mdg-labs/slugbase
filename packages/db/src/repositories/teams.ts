import type { NewTeam, TeamDetail, TeamListRequest, TeamMemberRecord, TeamRecord, TeamStore, TeamStoreCreationResult, TeamUpdateRequest, TeamUpdateResult } from "@slugbase/core";
import { and, asc, eq, not, sql } from "drizzle-orm";
import { accounts } from "../schema/accounts.ts";
import { teamMembers, teams } from "../schema/teams.ts";
import { TenantContextError, tenantHandle, type TenantTx } from "../tenant.ts";
import { distinctIdentifiers, requireIdentifiers, uuidArray } from "./folder-links.ts";
import { defineScopedRepository } from "./scoped.ts";

// The teams of the active workspace (doc 05 section 2.3, doc 02 section 4, doc 10 T1, T2 and T11). A team belongs to the workspace and to no
// member: the policies of `teams` and `team_members` name the workspace (src/sql/640-teams.sql), every statement below names it as well, and a
// team of another workspace is a row the statement does not find. Who may change a team is the operations' rule, which the server enforces
// before a handler runs. `slugbase_app` may insert the columns of a creation, update the name and the description, and delete; deleting a team
// deletes its memberships by foreign key, and a member who leaves the workspace leaves its teams by the foreign key to `workspace_members`.
//
// The unique key `(workspace_id, name)` is the judge of a name that is taken. A creation inserts with `ON CONFLICT DO NOTHING` and a change of
// the name updates only where no other team has it, so a name that is taken is an answer and not an error, and two creations of one name at the
// same time make one team. Two renames to one name that overlap can still both pass their check and meet at the key; the loser's statement
// fails, which ends the transaction it ran in with nothing written, and `isTeamNameTaken` tells that failure from any other so the caller
// answers it as a name that is taken.
//
// A change locks the team's row and compares its version with the caller's `If-Match` under that lock. Replacing the members does the same, and
// the version covers the member set: a replacement that changes it writes `members_version`, which the trigger turns into one move of the
// version (src/sql/640-teams.sql). After the team's row it locks the membership rows of the accounts named (`FOR KEY SHARE`, in the order of
// their identifiers): an account that a concurrent transaction removes from the workspace is then either found gone or waited for, and never
// met half-way by the foreign key of the membership, and the removal of the member waits for this transaction to end.
//
// A replacement that carries a precondition is also `stale` when it adds an account whose `workspace_members.joined_at` is later than the team's
// `versioned_at`: the time the transaction that wrote the version began, against the time the transaction that joined the account began. A
// member who left the workspace takes its team memberships without moving the version, and one that joins without an invitation (an instance
// admin adding themselves) moves none either, so the version alone would let a form read before the account left put it back. Both times are
// the database's `now()`, and a join that began before the version was written is not caught by this comparison; every join through an
// invitation moves the versions itself (src/sql/640-teams.sql). The refusal moves the version, once, so that a caller who reads the team again
// and names the account is not refused by the same join.

const scoped = defineScopedRepository("teams", teams, {
  insertColumns: ["id", "name", "description"],
  updateColumns: ["name", "description", "membersVersion"],
});

// The registry entry of `team_members` for the cross-tenant matrix (doc 08 section 3.3): the application role may read, insert (the two columns of a
// membership) and delete memberships, and the policies keep each to the workspace of the transaction. Memberships are written in sets by
// `replaceMembers`, whose statement is the one the entry's insert is judged by.
const memberships = defineScopedRepository("team_members", teamMembers, {
  methods: ["select", "insert", "delete"],
  insertColumns: ["teamId", "accountId"],
});

const UNIQUE_VIOLATION = "23505";
const NAME_CONSTRAINT = "teams_name_key";
const MAX_CAUSE_DEPTH = 4;

/** Whether the error is the database refusing a statement because the workspace has a team of that name already, on the error itself or on one of its causes. */
export function isTeamNameTaken(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof current === "object" && current !== null; depth += 1) {
    const { code, constraint_name: constraint, cause } = current as { code?: unknown; constraint_name?: unknown; cause?: unknown };
    if (code === UNIQUE_VIOLATION && constraint === NAME_CONSTRAINT) {
      return true;
    }
    current = cause;
  }
  return false;
}

function requireWorkspace(tx: TenantTx): string {
  if (tx.workspaceId === undefined) {
    throw new TenantContextError("workspace_required", "the teams of a workspace need a tenant transaction opened with a workspace");
  }
  return tx.workspaceId;
}

/** The teams of the workspace of the transaction, or the one team `teamId`, with their member counts, in the order of name and identifier, after `after`, at most `limit`. */
function teamsOf(
  tx: TenantTx,
  request: { readonly teamId: string | undefined; readonly after: TeamListRequest["after"]; readonly limit: number | undefined },
): Promise<TeamRecord[]> {
  const workspaceId = requireWorkspace(tx);
  const { teamId, after, limit } = request;
  const query = tenantHandle(tx)
    .select({
      id: teams.id,
      name: teams.name,
      description: teams.description,
      memberCount: sql<number>`count(${teamMembers.accountId})::int`,
      version: teams.version,
      createdAt: teams.createdAt,
      updatedAt: teams.updatedAt,
    })
    .from(teams)
    .leftJoin(teamMembers, and(eq(teamMembers.workspaceId, teams.workspaceId), eq(teamMembers.teamId, teams.id)))
    .where(
      and(
        eq(teams.workspaceId, workspaceId),
        teamId === undefined ? undefined : eq(teams.id, teamId),
        after === undefined ? undefined : sql`(${teams.name}, ${teams.id}) > (${after.name}::citext, ${after.id}::uuid)`,
      ),
    )
    .groupBy(teams.id)
    .orderBy(asc(teams.name), asc(teams.id));
  return limit === undefined ? query : query.limit(limit);
}

async function membersOf(tx: TenantTx, teamId: string): Promise<TeamMemberRecord[]> {
  const workspaceId = requireWorkspace(tx);
  return tenantHandle(tx)
    .select({ accountId: accounts.id, displayName: accounts.displayName, email: accounts.email })
    .from(teamMembers)
    .innerJoin(accounts, eq(accounts.id, teamMembers.accountId))
    .where(and(eq(teamMembers.workspaceId, workspaceId), eq(teamMembers.teamId, teamId)))
    .orderBy(asc(accounts.displayName), asc(accounts.id));
}

async function detailOf(tx: TenantTx, teamId: string): Promise<TeamDetail | undefined> {
  const [team] = await teamsOf(tx, { teamId, after: undefined, limit: undefined });
  return team === undefined ? undefined : { ...team, members: await membersOf(tx, teamId) };
}

async function requireDetail(tx: TenantTx, teamId: string): Promise<TeamDetail> {
  const detail = await detailOf(tx, teamId);
  if (detail === undefined) {
    throw new Error("a locked team cannot be read back");
  }
  return detail;
}

export type TeamRepository = TeamStore;

export function teamRepository(tx: TenantTx): TeamRepository {
  const rows = scoped.bind(tx);
  const links = memberships.bind(tx);
  return {
    async create(team: NewTeam): Promise<TeamStoreCreationResult> {
      const workspaceId = requireWorkspace(tx);
      // The statement names the columns the application role may insert; the query builder would name the version and the timestamps too.
      const inserted = await tenantHandle(tx).execute<{ id: string }>(sql`
        INSERT INTO ${teams} (id, workspace_id, name, description) VALUES (${team.id}, ${workspaceId}, ${team.name}, ${team.description})
        ON CONFLICT (workspace_id, name) DO NOTHING
        RETURNING id`);
      if (inserted.length === 0) {
        return { kind: "name_taken" };
      }
      return { kind: "created", team: await requireDetail(tx, team.id) };
    },

    async list({ after, limit }: TeamListRequest) {
      return teamsOf(tx, { teamId: undefined, after, limit });
    },

    find: (teamId) => detailOf(tx, teamId),

    async update({ teamId, changes, expectedVersions }: TeamUpdateRequest): Promise<TeamUpdateResult> {
      const workspaceId = requireWorkspace(tx);
      const [current] = await tenantHandle(tx)
        .select()
        .from(teams)
        .where(and(eq(teams.workspaceId, workspaceId), eq(teams.id, teamId)))
        .for("update");
      if (current === undefined) {
        return { kind: "not_found" };
      }
      if (expectedVersions !== undefined && !expectedVersions.includes(current.version)) {
        return { kind: "stale" };
      }
      const set: Parameters<typeof rows.update>[0] = {};
      if (changes.name !== undefined && changes.name !== current.name) {
        set.name = changes.name;
      }
      if (changes.description !== undefined && changes.description !== current.description) {
        set.description = changes.description;
      }
      if (Object.keys(set).length === 0) {
        return { kind: "unchanged", team: await requireDetail(tx, teamId) };
      }
      const taken = sql`EXISTS (SELECT 1 FROM ${teams} AS other WHERE other.workspace_id = ${teams.workspaceId} AND other.name = ${set.name ?? current.name} AND other.id <> ${teams.id})`;
      const updated = await rows.update(set, and(eq(teams.id, teamId), set.name === undefined ? undefined : not(taken)));
      if (updated.length === 0) {
        // The row is locked by this transaction, so it still exists in the workspace: another team has the name.
        return { kind: "name_taken" };
      }
      return { kind: "updated", team: await requireDetail(tx, teamId), previousName: current.name };
    },

    async remove(teamId) {
      const deleted = await rows.delete(eq(teams.id, teamId));
      return deleted[0]?.name;
    },

    async replaceMembers({ teamId, accountIds, expectedVersions }) {
      const workspaceId = requireWorkspace(tx);
      const [locked] = await tenantHandle(tx)
        .select({ id: teams.id, version: teams.version, membersVersion: teams.membersVersion })
        .from(teams)
        .where(and(eq(teams.workspaceId, workspaceId), eq(teams.id, teamId)))
        .for("update");
      if (locked === undefined) {
        return { kind: "not_found" };
      }
      if (expectedVersions !== undefined && !expectedVersions.includes(locked.version)) {
        return { kind: "stale" };
      }
      const wanted = distinctIdentifiers(accountIds);
      requireIdentifiers(wanted, "replacing the members of a team");
      if (wanted.length > 0) {
        const held = await tenantHandle(tx).execute<{ account_id: string }>(sql`
          SELECT account_id FROM public.workspace_members
          WHERE workspace_id = ${workspaceId}::uuid AND account_id = ANY (${uuidArray(wanted)}::uuid[])
          ORDER BY account_id
          FOR KEY SHARE`);
        if (held.length !== wanted.length) {
          return { kind: "unknown_members" };
        }
      }
      const present = (await links.select(eq(teamMembers.teamId, teamId))).map((link) => link.accountId);
      const toRemove = present.filter((accountId) => !wanted.includes(accountId));
      const toAdd = wanted.filter((accountId) => !present.includes(accountId));
      if (expectedVersions !== undefined && toAdd.length > 0) {
        // An account this replacement adds that joined the workspace after the version was written (an instance admin who left and added
        // themselves again moves no version) may have been absent from the form the caller read, or left and returned since. The one write
        // is the version moving, so the caller's next read carries a version the join precedes; the set stays as it was.
        const joined = await tenantHandle(tx).execute(sql`
          SELECT 1 FROM public.workspace_members m
          WHERE m.workspace_id = ${workspaceId}::uuid AND m.account_id = ANY (${uuidArray(toAdd)}::uuid[])
            AND m.joined_at > (SELECT t.versioned_at FROM ${teams} AS t WHERE t.id = ${teamId}::uuid)
          LIMIT 1`);
        if (joined.length > 0) {
          await rows.update({ membersVersion: locked.membersVersion + 1 }, eq(teams.id, teamId));
          return { kind: "stale" };
        }
      }
      if (toRemove.length > 0) {
        await links.delete(and(eq(teamMembers.teamId, teamId), sql`${teamMembers.accountId} = ANY (${uuidArray(toRemove)}::uuid[])`));
      }
      if (toAdd.length > 0) {
        // The statement names the columns the application role may insert (a column grant) and writes the whole set in one round trip.
        await tenantHandle(tx).execute(sql`
          INSERT INTO ${teamMembers} (workspace_id, team_id, account_id)
          SELECT ${workspaceId}::uuid, ${teamId}::uuid, a.id FROM unnest(${uuidArray(toAdd)}::uuid[]) AS a(id)
          ON CONFLICT (team_id, account_id) DO NOTHING`);
      }
      if (toRemove.length + toAdd.length === 0) {
        return { kind: "unchanged", team: await requireDetail(tx, teamId) };
      }
      // The trigger moves the member revision and the version by one, whatever value is written here.
      await rows.update({ membersVersion: locked.membersVersion + 1 }, eq(teams.id, teamId));
      return { kind: "replaced", team: await requireDetail(tx, teamId), added: toAdd.length, removed: toRemove.length };
    },
  };
}
