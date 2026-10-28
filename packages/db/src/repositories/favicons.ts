import { and, eq, isNull, sql } from "drizzle-orm";
import { bookmarks } from "../schema/bookmarks.ts";
import type { FaviconStatus } from "../schema/favicons.ts";
import { enqueueInTenantTransaction, type QueuedJob } from "../system/queue.ts";
import { TenantContextError, tenantHandle, type TenantTx } from "../tenant.ts";
import { bookmarkReadableBy } from "./bookmark-access.ts";

// The favicon cache (doc 05 sections 2.7 and 3.3, doc 02 section 5.4, doc 10 T1, T6 and T14). The cache is deployment-wide, one row for each host, and the
// application role reaches the table only through the system operations `sys_favicon_get` and `sys_favicon_put` (src/sql/630-favicons.sql), which this
// repository calls. What is tenant-scoped is the question of whether a fetch may be started for a host: only for a host of a bookmark the account of the
// transaction can read in the workspace of the transaction (`hostReadable`), so the favicon operation cannot be used to make the server fetch a host the
// caller has no bookmark on.

/** The sizes of the stored PNG, in pixels. */
export type FaviconSize = 32 | 64;

/** What the cache holds for a host that has not expired: an icon of the size asked for, or the record that the host has none. */
export type FaviconRecord = { readonly status: "ok"; readonly png: Uint8Array } | { readonly status: "none" };

/** The result of a fetch: the 64 px and the 32 px PNG of an icon, or that the host has none. */
export type FaviconResult = { readonly status: "ok"; readonly png64: Uint8Array; readonly png32: Uint8Array } | { readonly status: "none" };

export interface FaviconRepository {
  /**
   * Whether the account of the transaction can read a bookmark in the workspace of the transaction whose host is `host` (lower case). Plan-archived
   * bookmarks do not count. Only reads. Needs a transaction opened with a workspace.
   */
  hostReadable(host: string): Promise<boolean>;
  /** The row of the host when it has not expired by the database clock; undefined for an unknown or expired host. Needs a tenant transaction. */
  current(host: string, size: FaviconSize): Promise<FaviconRecord | undefined>;
  /** Stores the result for the host, replacing an earlier row, with `fetched_at` and `expires_at` from the database clock. Needs a tenant transaction. */
  store(host: string, result: FaviconResult): Promise<void>;
  /** Queues `job` in the open transaction; a job with the singleton key of a waiting job is dropped. Needs a tenant transaction. */
  enqueue(job: QueuedJob): Promise<void>;
}

type CurrentRow = {
  status: FaviconStatus;
  content: Uint8Array | null;
};

function requireWorkspace(tx: TenantTx): string {
  if (tx.workspaceId === undefined) {
    throw new TenantContextError("workspace_required", "the favicon cache of a workspace needs a tenant transaction opened with a workspace");
  }
  return tx.workspaceId;
}

export function faviconRepository(tx: TenantTx): FaviconRepository {
  return {
    async hostReadable(host) {
      const workspaceId = requireWorkspace(tx);
      const [row] = await tenantHandle(tx)
        .select({ id: bookmarks.id })
        .from(bookmarks)
        .where(and(eq(bookmarks.workspaceId, workspaceId), eq(bookmarks.host, host), isNull(bookmarks.planArchivedAt), bookmarkReadableBy(tx.accountId)))
        .limit(1);
      return row !== undefined;
    },

    async current(host, size) {
      const [row] = await tenantHandle(tx).execute<CurrentRow>(sql`SELECT status, content FROM sys_favicon_get(${host}::text, ${size}::integer)`);
      if (row === undefined) {
        return undefined;
      }
      if (row.status === "ok") {
        if (row.content === null) {
          throw new Error("sys_favicon_get answered an ok row without content");
        }
        return { status: "ok", png: new Uint8Array(row.content) };
      }
      return { status: "none" };
    },

    async store(host, result) {
      const png64 = result.status === "ok" ? Buffer.from(result.png64) : null;
      const png32 = result.status === "ok" ? Buffer.from(result.png32) : null;
      await tenantHandle(tx).execute(sql`SELECT sys_favicon_put(${host}::text, ${result.status}::text, ${png64}::bytea, ${png32}::bytea)`);
    },

    async enqueue(job) {
      await enqueueInTenantTransaction(tx, job);
    },
  };
}
