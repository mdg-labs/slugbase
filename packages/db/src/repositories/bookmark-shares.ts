import type { BookmarkBulkStore, BookmarkShareGrant, BookmarkShareList, BookmarkShareRecord, BookmarkShareStore, NewBookmarkShare, ShareTargetRecord, ShareTargetSearch, ShareTargetStore } from "@slugbase/core";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { accounts } from "../schema/accounts.ts";
import { bookmarks } from "../schema/bookmarks.ts";
import { bookmarkReadableBy } from "./bookmark-access.ts";
import { bookmarkShares } from "../schema/shares.ts";
import { teams } from "../schema/teams.ts";
import { distinctIdentifiers, requireIdentifiers, uuidArray } from "./folder-links.ts";
import { TenantContextError, tenantHandle, type TenantTx } from "../tenant.ts";
import { defineScopedRepository } from "./scoped.ts";

// The shares of bookmarks and the targets to share with (doc 05 section 2.5, doc 02 section 8, doc 10 T1, T2 and T11). Every statement names the
// workspace of the transaction, and the policies of `bookmark_shares` (src/sql/650-bookmark-shares.sql) admit a write only for a bookmark owned by the
// account of the transaction, in its own name, so a statement that forgot a predicate still writes no share of anyone else's bookmark. The caller of a
// write has checked that the bookmark is the account's own; the repository checks it again under the lock it takes (`ownedBookmark`).
//
// A grant locks the bookmark, and then its target (the membership row of a member, the row of a team), with `FOR KEY SHARE` before it writes: a
// member who leaves the workspace and a team that is deleted at the same time are then either found gone or waited for, and never met half-way by
// the composite foreign key of the share. The removal of the member or of the team waits for this transaction to end, and its cascade removes the share.
// Sharing twice with one target is one share: the insert does nothing for a target the bookmark is shared with already, and the share that exists is
// read back. A bulk share locks the bookmarks it reaches (in the order of their identifiers) and then the target, as a grant does, and writes the
// missing shares in one statement; it reads the shares again afterwards, so a share another transaction revoked in the meantime is written again.

// The registry entry of `bookmark_shares` for the cross-tenant matrix (doc 08 section 3.3): the application role may read, insert (the columns of a
// grant) and delete shares, and the policies keep each to the workspace of the transaction and, for a write, to the account's own bookmark. Shares are
// written by `grant`, whose statement is the one the entry's insert is judged by, and removed through the entry's delete.
const scoped = defineScopedRepository("bookmark_shares", bookmarkShares, {
  methods: ["select", "insert", "delete"],
  insertColumns: ["id", "bookmarkId", "targetAccountId", "targetTeamId", "grantedBy"],
});

/** How often a grant that met a share another transaction revoked at that moment tries again. */
const GRANT_ATTEMPTS = 3;

function requireWorkspace(tx: TenantTx): string {
  if (tx.workspaceId === undefined) {
    throw new TenantContextError("workspace_required", "the shares of a workspace need a tenant transaction opened with a workspace");
  }
  return tx.workspaceId;
}

/** The pattern of a search: the text with the characters `LIKE` reads as wildcards escaped, inside the wildcards of "contains". */
function containsPattern(search: string): string {
  return `%${search.replace(/[\\%_]/g, "\\$&")}%`;
}

interface ShareRow extends Record<string, unknown> {
  id: string;
  bookmark_id: string;
  target_account_id: string | null;
  target_team_id: string | null;
  created_at: Date;
  name: string | null;
  email: string | null;
}

function recordOf(row: ShareRow): BookmarkShareRecord {
  if (row.name === null) {
    throw new Error("the target of a share cannot be read");
  }
  return {
    id: row.id,
    bookmarkId: row.bookmark_id,
    accountId: row.target_account_id,
    teamId: row.target_team_id,
    name: row.name,
    email: row.email,
    createdAt: new Date(row.created_at),
  };
}

/**
 * The shares of the bookmark in the order of their creation, or the one share `filter.shareId`, or the one that names `filter.target`, with the name of
 * their target as it is now: the display name and address of a member (the co-member projection of its account), the name of a team.
 */
async function sharesOf(tx: TenantTx, bookmarkId: string, filter: { readonly shareId?: string; readonly target?: NewBookmarkShare["target"] } = {}): Promise<BookmarkShareRecord[]> {
  const workspaceId = requireWorkspace(tx);
  const { shareId, target } = filter;
  const rows = await tenantHandle(tx).execute<ShareRow>(sql`
    SELECT s.id, s.bookmark_id, s.target_account_id, s.target_team_id, s.created_at, coalesce(a.display_name, t.name::text) AS name, a.email::text AS email
    FROM ${bookmarkShares} s
    LEFT JOIN ${accounts} a ON a.id = s.target_account_id
    LEFT JOIN ${teams} t ON t.workspace_id = s.workspace_id AND t.id = s.target_team_id
    WHERE s.workspace_id = ${workspaceId}::uuid AND s.bookmark_id = ${bookmarkId}::uuid
      ${shareId === undefined ? sql`` : sql`AND s.id = ${shareId}::uuid`}
      ${target === undefined ? sql`` : target.kind === "member" ? sql`AND s.target_account_id = ${target.accountId}::uuid` : sql`AND s.target_team_id = ${target.teamId}::uuid`}
    ORDER BY s.created_at, s.id`);
  return rows.map(recordOf);
}

/** The distinct members other than the owner who can read the bookmark through its shares: the members it is shared with and those of the teams it is shared with. */
async function audienceOf(tx: TenantTx, bookmarkId: string): Promise<number> {
  const workspaceId = requireWorkspace(tx);
  const [row] = await tenantHandle(tx).execute<{ audience: number }>(sql`
    SELECT count(DISTINCT audience.account_id)::int AS audience
    FROM (
      SELECT s.target_account_id AS account_id
      FROM ${bookmarkShares} s
      WHERE s.workspace_id = ${workspaceId}::uuid AND s.bookmark_id = ${bookmarkId}::uuid AND s.target_account_id IS NOT NULL
      UNION ALL
      SELECT m.account_id
      FROM ${bookmarkShares} s
      JOIN public.team_members m ON m.workspace_id = s.workspace_id AND m.team_id = s.target_team_id
      WHERE s.workspace_id = ${workspaceId}::uuid AND s.bookmark_id = ${bookmarkId}::uuid
    ) audience
    WHERE audience.account_id IS DISTINCT FROM (SELECT b.owner_id FROM ${bookmarks} b WHERE b.workspace_id = ${workspaceId}::uuid AND b.id = ${bookmarkId}::uuid)`);
  return row?.audience ?? 0;
}

/** The owner's own bookmarks of `bookmarkIds` in the workspace of the transaction that are not plan-archived, in the order of their identifiers; locked against their deletion when `lock` is true. */
async function ownedLiveBookmarks(tx: TenantTx, ownerId: string, bookmarkIds: readonly string[], lock: boolean): Promise<string[]> {
  const workspaceId = requireWorkspace(tx);
  if (ownerId.toLowerCase() !== tx.accountId.toLowerCase()) {
    throw new Error("only the account of the transaction shares its own bookmarks");
  }
  const wanted = distinctIdentifiers(bookmarkIds);
  requireIdentifiers(wanted, "sharing bookmarks");
  if (wanted.length === 0) {
    return [];
  }
  const query = tenantHandle(tx)
    .select({ id: bookmarks.id })
    .from(bookmarks)
    .where(and(eq(bookmarks.workspaceId, workspaceId), eq(bookmarks.ownerId, ownerId), isNull(bookmarks.planArchivedAt), sql`${bookmarks.id} = ANY (${uuidArray(wanted)}::uuid[])`))
    .orderBy(bookmarks.id);
  return (lock ? await query.for("key share") : await query).map((row) => row.id);
}

/**
 * The name of a member or a team of the workspace of the transaction, or undefined when it is none. With `lock` the member's row of the membership, or the team's row,
 * is locked against its removal for the rest of the transaction.
 */
async function targetName(tx: TenantTx, target: NewBookmarkShare["target"], lock: boolean): Promise<string | undefined> {
  const workspaceId = requireWorkspace(tx);
  const handle = tenantHandle(tx);
  const rows =
    target.kind === "member"
      ? await handle.execute<{ name: string }>(sql`
          SELECT a.display_name AS name
          FROM public.workspace_members wm
          JOIN ${accounts} a ON a.id = wm.account_id
          WHERE wm.workspace_id = ${workspaceId}::uuid AND wm.account_id = ${target.accountId}::uuid
          ${lock ? sql`FOR KEY SHARE OF wm` : sql``}`)
      : await handle.execute<{ name: string }>(sql`
          SELECT t.name::text AS name
          FROM ${teams} t
          WHERE t.workspace_id = ${workspaceId}::uuid AND t.id = ${target.teamId}::uuid
          ${lock ? sql`FOR KEY SHARE OF t` : sql``}`);
  return rows[0]?.name;
}

/** Those of `bookmarkIds` that are not shared with `target`. */
async function unsharedWith(tx: TenantTx, bookmarkIds: readonly string[], target: NewBookmarkShare["target"]): Promise<string[]> {
  if (bookmarkIds.length === 0) {
    return [];
  }
  const workspaceId = requireWorkspace(tx);
  const rows = await tenantHandle(tx).execute<{ id: string }>(sql`
    SELECT b.id::text AS id
    FROM unnest(${uuidArray(bookmarkIds)}::uuid[]) AS b(id)
    WHERE NOT EXISTS (
      SELECT 1 FROM ${bookmarkShares} s
      WHERE s.workspace_id = ${workspaceId}::uuid AND s.bookmark_id = b.id
        AND ${target.kind === "member" ? sql`s.target_account_id = ${target.accountId}::uuid` : sql`s.target_team_id = ${target.teamId}::uuid`}
    )
    ORDER BY b.id`);
  return rows.map((row) => row.id);
}

/** The members other than `ownerId` who read through the target: the member itself, or the members of the team. */
async function memberCountOf(tx: TenantTx, target: NewBookmarkShare["target"], ownerId: string): Promise<number> {
  if (target.kind === "member") {
    return 1;
  }
  const workspaceId = requireWorkspace(tx);
  const [row] = await tenantHandle(tx).execute<{ members: number }>(sql`
    SELECT count(*)::int AS members
    FROM public.team_members m
    WHERE m.workspace_id = ${workspaceId}::uuid AND m.team_id = ${target.teamId}::uuid AND m.account_id <> ${ownerId}::uuid`);
  return row?.members ?? 0;
}

export type BookmarkShareRepository = BookmarkShareStore & Pick<BookmarkBulkStore, "share" | "previewShare">;

export function bookmarkShareRepository(tx: TenantTx): BookmarkShareRepository {
  const rows = scoped.bind(tx);
  return {
    async ownedBookmark({ bookmarkId, ownerId, use }) {
      const workspaceId = requireWorkspace(tx);
      const query = tenantHandle(tx)
        .select({ id: bookmarks.id })
        .from(bookmarks)
        .where(
          and(
            eq(bookmarks.workspaceId, workspaceId),
            eq(bookmarks.id, bookmarkId),
            eq(bookmarks.ownerId, ownerId),
            // A bookmark the plan has archived is not one the product shows, so it is not shared; its shares can still be read and ended.
            use === "grant" ? isNull(bookmarks.planArchivedAt) : undefined,
          ),
        );
      return (use === "grant" ? await query.for("key share") : await query).length === 1;
    },

    async sharedWith({ bookmarkId, accountId }) {
      const workspaceId = requireWorkspace(tx);
      if (accountId.toLowerCase() !== tx.accountId.toLowerCase()) {
        throw new Error("only the account of the transaction asks whether a bookmark is shared with it");
      }
      const found = await tenantHandle(tx)
        .select({ id: bookmarks.id })
        .from(bookmarks)
        .where(
          and(
            eq(bookmarks.workspaceId, workspaceId),
            eq(bookmarks.id, bookmarkId),
            isNull(bookmarks.planArchivedAt),
            sql`${bookmarks.ownerId} IS DISTINCT FROM ${accountId}::uuid`,
            bookmarkReadableBy(accountId),
          ),
        );
      return found.length === 1;
    },

    async list(bookmarkId): Promise<BookmarkShareList> {
      return { shares: await sharesOf(tx, bookmarkId), audienceSize: await audienceOf(tx, bookmarkId) };
    },

    async grant({ id, bookmarkId, grantedBy, target }): Promise<BookmarkShareGrant> {
      const workspaceId = requireWorkspace(tx);
      const handle = tenantHandle(tx);
      const held =
        target.kind === "member"
          ? await handle.execute(sql`
              SELECT account_id FROM public.workspace_members
              WHERE workspace_id = ${workspaceId}::uuid AND account_id = ${target.accountId}::uuid
              FOR KEY SHARE`)
          : await handle
              .select({ id: teams.id })
              .from(teams)
              .where(and(eq(teams.workspaceId, workspaceId), eq(teams.id, target.teamId)))
              .for("key share");
      if (held.length === 0) {
        return { kind: "unknown_target" };
      }
      for (let attempt = 0; attempt < GRANT_ATTEMPTS; attempt += 1) {
        // The statement names the columns the application role may insert (a column grant). `ON CONFLICT DO NOTHING` leaves a target the bookmark is shared with already, whichever of the two unique indexes judges it.
        const inserted = await handle.execute(sql`
          INSERT INTO ${bookmarkShares} (id, workspace_id, bookmark_id, target_account_id, target_team_id, granted_by)
          VALUES (${id}::uuid, ${workspaceId}::uuid, ${bookmarkId}::uuid, ${target.kind === "member" ? target.accountId : null}::uuid, ${target.kind === "team" ? target.teamId : null}::uuid, ${grantedBy}::uuid)
          ON CONFLICT DO NOTHING
          RETURNING id`);
        const [share] = await sharesOf(tx, bookmarkId, inserted.length === 1 ? { shareId: id } : { target });
        if (share !== undefined) {
          return { kind: inserted.length === 1 ? "granted" : "existing", share };
        }
        // The share that made the insert do nothing was revoked before it could be read back: the insert is tried again.
      }
      throw new Error("a share could neither be written nor found");
    },

    async share({ bookmarkIds, ownerId, target, newId }) {
      const workspaceId = requireWorkspace(tx);
      // The bookmarks first and then the target, the order of a single grant.
      const owned = await ownedLiveBookmarks(tx, ownerId, bookmarkIds, true);
      const name = await targetName(tx, target, true);
      if (name === undefined) {
        return { kind: "unknown_target" };
      }
      let granted = 0;
      for (let attempt = 0; ; attempt += 1) {
        const missing = await unsharedWith(tx, owned, target);
        if (missing.length === 0) {
          return { kind: "done", affected: owned.length, granted, targetName: name };
        }
        if (attempt >= GRANT_ATTEMPTS) {
          throw new Error("shares could neither be written nor found");
        }
        const ids = missing.map(() => newId().toLowerCase());
        requireIdentifiers(ids, "sharing bookmarks");
        // The statement names the columns the application role may insert (a column grant). `ON CONFLICT DO NOTHING` leaves a target a bookmark is shared with already; one that another transaction revoked since is found missing by the next pass.
        const inserted = await tenantHandle(tx).execute(sql`
          INSERT INTO ${bookmarkShares} (id, workspace_id, bookmark_id, target_account_id, target_team_id, granted_by)
          SELECT n.id, ${workspaceId}::uuid, n.bookmark_id, ${target.kind === "member" ? target.accountId : null}::uuid, ${target.kind === "team" ? target.teamId : null}::uuid, ${ownerId}::uuid
          FROM unnest(${uuidArray(ids)}::uuid[], ${uuidArray(missing)}::uuid[]) AS n(id, bookmark_id)
          ON CONFLICT DO NOTHING
          RETURNING id`);
        granted += inserted.length;
      }
    },

    async previewShare({ bookmarkIds, ownerId, target }) {
      const owned = await ownedLiveBookmarks(tx, ownerId, bookmarkIds, false);
      const name = await targetName(tx, target, false);
      if (name === undefined) {
        return { kind: "unknown_target" };
      }
      const added = (await unsharedWith(tx, owned, target)).length;
      return {
        kind: "previewed",
        affected: owned.length,
        audience: { kind: target.kind, id: target.kind === "member" ? target.accountId : target.teamId, name, memberCount: await memberCountOf(tx, target, ownerId), added },
      };
    },

    async revoke({ bookmarkId, shareId }) {
      const [share] = await sharesOf(tx, bookmarkId, { shareId });
      if (share === undefined) {
        return undefined;
      }
      const deleted = await rows.delete(and(eq(bookmarkShares.id, shareId), eq(bookmarkShares.bookmarkId, bookmarkId)));
      return deleted.length === 1 ? share : undefined;
    },
  };
}

export type ShareTargetRepository = ShareTargetStore;

export function shareTargetRepository(tx: TenantTx): ShareTargetRepository {
  return {
    async search({ q, excludeAccountId, kinds, limit }: ShareTargetSearch): Promise<ShareTargetRecord[]> {
      const workspaceId = requireWorkspace(tx);
      const handle = tenantHandle(tx);
      const pattern = q === undefined ? undefined : containsPattern(q);
      const found: ShareTargetRecord[] = [];
      if (kinds.includes("member")) {
        const members = await handle.execute<{ id: string; name: string; email: string }>(sql`
          SELECT a.id, a.display_name AS name, a.email::text AS email
          FROM public.workspace_members wm
          JOIN ${accounts} a ON a.id = wm.account_id
          WHERE wm.workspace_id = ${workspaceId}::uuid AND wm.account_id <> ${excludeAccountId}::uuid
            ${pattern === undefined ? sql`` : sql`AND (a.display_name ILIKE ${pattern} OR a.email::text ILIKE ${pattern})`}
          ORDER BY lower(a.display_name), a.id
          LIMIT ${limit}`);
        found.push(...members.map((member) => ({ kind: "member" as const, id: member.id, name: member.name, email: member.email })));
      }
      if (kinds.includes("team")) {
        const teamRows = await handle
          .select({ id: teams.id, name: teams.name })
          .from(teams)
          .where(and(eq(teams.workspaceId, workspaceId), pattern === undefined ? undefined : sql`${teams.name}::text ILIKE ${pattern}`))
          .orderBy(asc(teams.name), asc(teams.id))
          .limit(limit);
        found.push(...teamRows.map((team) => ({ kind: "team" as const, id: team.id, name: team.name, email: null })));
      }
      return found
        .sort((left, right) => {
          const byName = left.name.toLowerCase().localeCompare(right.name.toLowerCase());
          return byName !== 0 ? byName : left.id.localeCompare(right.id);
        })
        .slice(0, limit);
    },
  };
}
