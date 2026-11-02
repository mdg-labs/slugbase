import type { ImportFolderToResolve, ImportResolved, ImportStore, ImportTagToResolve } from "@slugbase/core";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { bookmarks } from "../schema/bookmarks.ts";
import { folders } from "../schema/folders.ts";
import { tags } from "../schema/tags.ts";
import { enqueueInTenantTransaction, type QueuedJob } from "../system/queue.ts";
import { TenantContextError, tenantHandle, type TenantTx } from "../tenant.ts";
import { insertLinkPairs, requireIdentifiers } from "./folder-links.ts";
import { insertTagLinkPairs } from "./tag-links.ts";

// The reads of the import preview and the writes of the import (doc 02 section 13.1, doc 01 section 7.5, doc 10 T1 and T11). Every statement names the workspace of the transaction, and the duplicate check names the account of the
// transaction as the owner as well, so another member's bookmark, a bookmark with no owner and anything of another workspace is never a duplicate. A plan-archived bookmark is not one either: the
// lookup walks `bookmarks_owner_url_idx`, which holds the bookmarks that are not archived. The room under the workspace's ceiling is read from the counter of its row, which a creation keeps in step with the bookmarks
// that are not archived, and never from a count of the bookmarks. The import takes its places under the ceiling with `sys_bookmark_count_take_many`, which locks the workspace's row and raises the counter once for the
// whole import, and inserts the bookmarks in batches of one statement each in the same transaction, so a failure of any of them leaves neither a bookmark nor a place taken. A bookmark is written for the account of the
// transaction in the workspace of the transaction and for no other.
//
// The slugs, folders and tags of the file (doc 02 section 13.1, Q30, doc 10 T2) are the account's alone as well. A slug is a conflict when the account has it on any of its bookmarks of the workspace, plan-archived or not
// (`bookmarks_owner_slug_key`), and another member's slug, or an ownerless bookmark's, is none. A folder or a tag is matched among the account's own, without regard to case, and created for the account when it has none; one
// it has is used as it is, with its icon and colour. The existing ones are locked `FOR KEY SHARE` in the order of their identifiers and the new ones are inserted in the order of their lower-cased names, the lock order of
// `tag-links.ts`, and a name another transaction creates meanwhile is that transaction's row: the insert leaves it and the read that follows finds and locks it. A slug is inserted with its bookmark and never overwrites
// anything: the insert leaves a bookmark whose slug the account has on a bookmark by then (another transaction, which the check before the insert could not see), and the bookmark is inserted again without the slug and
// without forwarding, so a slug taken in that moment costs the bookmark its slug and not the import.

function requireWorkspace(tx: TenantTx): string {
  if (tx.workspaceId === undefined) {
    throw new TenantContextError("workspace_required", "the import needs a tenant transaction opened with a workspace");
  }
  return tx.workspaceId;
}

interface CountRow extends Record<string, unknown> {
  bookmark_count: number;
}

interface TakenManyRow extends Record<string, unknown> {
  outcome: string;
  taken: number | null;
  used: number | null;
}

/** Those of `names`, as they were asked, that match a row of `table` the account of the transaction owns in its workspace, without regard to case. */
async function existingNames(tx: TenantTx, table: typeof folders | typeof tags, names: readonly string[]): Promise<ReadonlySet<string>> {
  const workspaceId = requireWorkspace(tx);
  if (names.length === 0) {
    return new Set<string>();
  }
  const asked = JSON.stringify(names);
  const found = await tenantHandle(tx).execute<{ name: string }>(sql`
    SELECT DISTINCT v.name
    FROM jsonb_array_elements_text(${asked}::text::jsonb) AS v(name)
    WHERE EXISTS (SELECT 1 FROM ${table} AS t WHERE t.workspace_id = ${workspaceId}::uuid AND t.owner_id = ${tx.accountId}::uuid AND t.name = v.name::citext)`);
  return new Set(found.map((row) => row.name));
}

interface FirstSameRow extends Record<string, unknown> {
  first: number;
}

/**
 * For each of `names`, the place of the first one that `citext` compares as the same name: the rows are partitioned by the comparison of the type the name columns have, so the answer is that of the comparison
 * the unique indexes of the names use. It reads no table.
 */
async function firstSameNames(tx: TenantTx, names: readonly string[]): Promise<readonly number[]> {
  if (names.length === 0) {
    return [];
  }
  const asked = JSON.stringify(names);
  const rows = await tenantHandle(tx).execute<FirstSameRow>(sql`
    SELECT (min(v.n) OVER (PARTITION BY v.name::citext) - 1)::integer AS first
    FROM jsonb_array_elements_text(${asked}::text::jsonb) WITH ORDINALITY AS v(name, n)
    ORDER BY v.n`);
  return rows.map((row) => row.first);
}

/** The store of the import, less the events: they reach the repository as the jobs that announce them. */
export interface ImportRepository extends Omit<ImportStore, "insertBookmarks"> {
  /**
   * Inserts the bookmarks, in the order given, for the account of the transaction, and queues the jobs; every method needs a transaction opened with a workspace. A bookmark whose slug the account has on a bookmark by then
   * is inserted without the slug and without forwarding, and its identifier is answered in `slugsLost`.
   */
  insertBookmarks(batch: { readonly bookmarks: Parameters<ImportStore["insertBookmarks"]>[0]["bookmarks"]; readonly jobs: readonly QueuedJob[] }): Promise<{ readonly slugsLost: readonly string[] }>;
}

type NewBookmarks = Parameters<ImportStore["insertBookmarks"]>[0]["bookmarks"];

/** The rounds `resolveNames` reads and inserts for the names it is missing: a name another transaction creates and deletes again between the insert and the read is created anew, and a fourth failure ends the import. */
const RESOLVE_ROUNDS = 4;

interface NameToResolve {
  readonly id: string;
  readonly name: string;
  readonly icon?: string;
  readonly color?: number;
}

function byLowerCaseName(a: NameToResolve, b: NameToResolve): number {
  const left = a.name.toLowerCase();
  const right = b.name.toLowerCase();
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/**
 * Gets the account's folder or tag of each name (matched without regard to case) or creates it, in the transaction. The names are read and the rows found locked (`FOR KEY SHARE`, in the order of their identifiers); the
 * names that are missing are inserted in the order of their lower-cased names, leaving a row that another transaction created at the same time, and read again.
 */
async function resolveNames(tx: TenantTx, table: "folders" | "tags", wanted: readonly NameToResolve[]): Promise<ImportResolved> {
  const workspaceId = requireWorkspace(tx);
  requireIdentifiers(
    wanted.map((entry) => entry.id),
    "creating folders and tags",
  );
  const handle = tenantHandle(tx);
  const rows = table === "folders" ? folders : tags;
  const ids = new Map<string, string>();
  let created = 0;
  for (let round = 1; ; round += 1) {
    const pending = wanted.filter((entry) => !ids.has(entry.name));
    if (pending.length === 0) {
      break;
    }
    const names = JSON.stringify(pending.map((entry) => entry.name));
    const found = await handle.execute<{ asked: string; id: string }>(sql`
      SELECT v.name AS asked, t.id
      FROM jsonb_array_elements_text(${names}::text::jsonb) AS v(name)
      INNER JOIN ${rows} AS t ON t.workspace_id = ${workspaceId}::uuid AND t.owner_id = ${tx.accountId}::uuid AND t.name = v.name::citext
      ORDER BY t.id
      FOR KEY SHARE OF t`);
    for (const row of found) {
      ids.set(row.asked, row.id);
    }
    const missing = pending.filter((entry) => !ids.has(entry.name)).sort(byLowerCaseName);
    if (missing.length === 0) {
      break;
    }
    if (round === RESOLVE_ROUNDS) {
      throw new Error(`a ${table === "folders" ? "folder" : "tag"} the import creates was deleted by another transaction again and again`);
    }
    const values = JSON.stringify(missing.map((entry, n) => ({ n, id: entry.id, name: entry.name, icon: entry.icon ?? null, color: entry.color ?? null })));
    // The statements name the columns the application role may insert; the query builder would name `created_at` and the version too. `ORDER BY` fixes the order in which the unique index is entered.
    const inserted =
      table === "folders"
        ? await handle.execute<{ id: string }>(sql`
            INSERT INTO ${folders} (id, workspace_id, owner_id, name, icon, color)
            SELECT r.id, ${workspaceId}::uuid, ${tx.accountId}::uuid, r.name, r.icon, r.color
            FROM jsonb_to_recordset(${values}::text::jsonb) AS r(n integer, id uuid, name text, icon text, color smallint)
            ORDER BY r.n
            ON CONFLICT (workspace_id, owner_id, name) DO NOTHING
            RETURNING id`)
        : await handle.execute<{ id: string }>(sql`
            INSERT INTO ${tags} (id, workspace_id, owner_id, name)
            SELECT r.id, ${workspaceId}::uuid, ${tx.accountId}::uuid, r.name
            FROM jsonb_to_recordset(${values}::text::jsonb) AS r(n integer, id uuid, name text)
            ORDER BY r.n
            ON CONFLICT (workspace_id, owner_id, name) DO NOTHING
            RETURNING id`);
    created += inserted.length;
  }
  return { ids, created };
}

/** The ids of `batch` as the database writes them: lower case. */
function lowerIds(ids: Iterable<string>): Set<string> {
  return new Set([...ids].map((id) => id.toLowerCase()));
}

/** Inserts `batch` for the account of the transaction, leaving a row that conflicts with a row of the table, and answers the identifiers it inserted. */
async function insertRows(tx: TenantTx, workspaceId: string, batch: NewBookmarks): Promise<Set<string>> {
  const rows = JSON.stringify(
    batch.map((bookmark) => ({
      id: bookmark.id,
      url: bookmark.url,
      canonical: bookmark.urlCanonical,
      host: bookmark.host,
      title: bookmark.title,
      description: bookmark.description,
      pinned: bookmark.pinned,
      slug: bookmark.slug,
      forwarding: bookmark.forwarding,
    })),
  );
  const inserted = await tenantHandle(tx).execute<{ id: string }>(sql`
    INSERT INTO public.bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, description, pinned_at, slug, forwarding)
    SELECT r.id, ${workspaceId}::uuid, ${tx.accountId}::uuid, r.url, r.canonical, r.host, r.title, r.description, CASE WHEN r.pinned THEN now() END, r.slug, r.forwarding
    FROM jsonb_to_recordset(${rows}::text::jsonb) AS r(id uuid, url text, canonical text, host text, title text, description text, pinned boolean, slug text, forwarding boolean)
    ON CONFLICT DO NOTHING
    RETURNING id`);
  return lowerIds(inserted.map((row) => row.id));
}

/** The reads and writes of the import bound to the open transaction; every method needs a transaction opened with a workspace. */
export function importRepository(tx: TenantTx): ImportRepository {
  return {
    async bookmarkCount() {
      const workspaceId = requireWorkspace(tx);
      const rows = await tenantHandle(tx).execute<CountRow>(sql`
        SELECT bookmark_count FROM public.workspaces
        WHERE id = ${workspaceId}::uuid AND id IN (SELECT public.app_member_workspace_ids())`);
      return rows[0]?.bookmark_count;
    },

    async existingCanonicalUrls(canonicals) {
      const workspaceId = requireWorkspace(tx);
      if (canonicals.length === 0) {
        return new Set<string>();
      }
      const rows = await tenantHandle(tx)
        .selectDistinct({ canonical: bookmarks.urlCanonical })
        .from(bookmarks)
        .where(and(eq(bookmarks.workspaceId, workspaceId), eq(bookmarks.ownerId, tx.accountId), isNull(bookmarks.planArchivedAt), inArray(bookmarks.urlCanonical, [...canonicals])));
      return new Set(rows.map((row) => row.canonical));
    },

    async takePlaces(ceiling, wanted) {
      const workspaceId = requireWorkspace(tx);
      const taken = await tenantHandle(tx).execute<TakenManyRow>(sql`
        SELECT outcome, taken, used FROM public.sys_bookmark_count_take_many(${workspaceId}::uuid, ${ceiling}::integer, ${wanted}::integer)`);
      const row = taken[0];
      if (taken.length !== 1 || row === undefined) {
        throw new Error("sys_bookmark_count_take_many did not return exactly one row");
      }
      if (row.outcome === "unavailable") {
        return { kind: "unavailable" };
      }
      if ((row.outcome !== "taken" && row.outcome !== "limit_reached") || row.taken === null || row.used === null) {
        throw new Error("sys_bookmark_count_take_many returned an answer outside taken, limit_reached and unavailable");
      }
      return { kind: "taken", taken: row.taken, used: row.used };
    },

    async insertBookmarks({ bookmarks: batch, jobs }) {
      const workspaceId = requireWorkspace(tx);
      if (batch.some((bookmark) => bookmark.ownerId.toLowerCase() !== tx.accountId.toLowerCase())) {
        throw new Error("only the account of the transaction imports its own bookmarks");
      }
      const slugsLost: string[] = [];
      if (batch.length > 0) {
        const inserted = await insertRows(tx, workspaceId, batch);
        const left = batch.filter((bookmark) => !inserted.has(bookmark.id.toLowerCase()));
        if (left.some((bookmark) => bookmark.slug === null)) {
          throw new Error("the insert left out a bookmark that holds no slug");
        }
        if (left.length > 0) {
          const again = await insertRows(
            tx,
            workspaceId,
            left.map((bookmark) => ({ ...bookmark, slug: null, forwarding: false })),
          );
          if (again.size !== left.length) {
            throw new Error("the insert left out a bookmark that holds no slug");
          }
          slugsLost.push(...left.map((bookmark) => bookmark.id));
        }
      }
      for (const job of jobs) {
        await enqueueInTenantTransaction(tx, job);
      }
      return { slugsLost };
    },

    async existingSlugs(slugs) {
      const workspaceId = requireWorkspace(tx);
      if (slugs.length === 0) {
        return new Set<string>();
      }
      const found = await tenantHandle(tx)
        .selectDistinct({ slug: bookmarks.slug })
        .from(bookmarks)
        .where(and(eq(bookmarks.workspaceId, workspaceId), eq(bookmarks.ownerId, tx.accountId), inArray(bookmarks.slug, [...slugs])));
      return new Set(found.flatMap((row) => (row.slug === null ? [] : [row.slug])));
    },

    async existingFolderNames(names) {
      return existingNames(tx, folders, names);
    },

    async existingTagNames(names) {
      return existingNames(tx, tags, names);
    },

    firstSameNames(names) {
      return firstSameNames(tx, names);
    },

    resolveFolders(wanted: readonly ImportFolderToResolve[]) {
      return resolveNames(tx, "folders", wanted);
    },

    resolveTags(wanted: readonly ImportTagToResolve[]) {
      return resolveNames(tx, "tags", wanted);
    },

    async linkBookmarks({ folders: folderLinks, tags: tagLinks }) {
      requireWorkspace(tx);
      await insertLinkPairs(tx, folderLinks);
      await insertTagLinkPairs(tx, tagLinks);
    },
  };
}
