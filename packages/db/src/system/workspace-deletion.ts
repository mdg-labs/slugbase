import postgres from "postgres";
import { WORKSPACE_PURGE_BATCH_SIZE, workspacePurgeOrder } from "../purge-registry.ts";
import { enqueueInTransaction, type QueuedJob } from "./queue.ts";

// The wrappers of the system operations sys_workspace_purge_batch and sys_workspace_delete_finish (doc 05
// sections 3.3 and 7.2): the background half of deleting a workspace. They run on a pool of their own as the
// application role, outside any tenant transaction, because the operations refuse a transaction that acts for
// an account or a workspace. The request half, sys_workspace_mark_deleting, is a method of the workspace
// repository.

export interface WorkspaceDeletionStore {
  /**
   * Deletes the rows of the workspace table by table in the order of `workspacePurgeOrder`, in batches that
   * each commit on their own, until every table is empty. Rows already deleted stay deleted, so a run that
   * was interrupted and is repeated continues where the last one stopped. Touches only the workspace named
   * and only while it is being deleted: for a workspace that is not, or is gone, it deletes nothing. Returns
   * how many rows it deleted per table. Rejects when the database cannot answer.
   */
  purgeRows(workspaceId: string): Promise<Readonly<Record<string, number>>>;
  /**
   * Deletes the workspace row, which cascades what is left, and queues `jobs` in the same transaction, so the
   * jobs exist exactly when the row is gone. False, with nothing queued, when the workspace is not being
   * deleted or is gone already; a repeated call after the row is gone therefore announces nothing again.
   */
  finish(workspaceId: string, jobs: readonly QueuedJob[]): Promise<boolean>;
}

export interface WorkspaceDeletionStoreOptions {
  /** Connection URL of the application role (`DATABASE_URL`). */
  url: string;
  /** Maximum number of connections in the pool. */
  poolSize?: number;
}

interface CountRow {
  deleted: number;
}

interface FinishedRow {
  finished: boolean;
}

/** Binds the store to a connection pool that connects as the application role. */
export function bindWorkspaceDeletionStore(client: postgres.Sql): WorkspaceDeletionStore {
  return {
    async purgeRows(workspaceId) {
      const counts: Record<string, number> = {};
      for (const table of workspacePurgeOrder) {
        let total = 0;
        for (;;) {
          const rows = await client<CountRow[]>`
            SELECT public.sys_workspace_purge_batch(${workspaceId}::uuid, ${table}::text, ${WORKSPACE_PURGE_BATCH_SIZE}::integer) AS deleted`;
          const row = rows[0];
          if (rows.length !== 1 || row === undefined) {
            throw new Error("sys_workspace_purge_batch did not return exactly one row");
          }
          total += row.deleted;
          if (row.deleted < WORKSPACE_PURGE_BATCH_SIZE) {
            break;
          }
        }
        counts[table] = total;
      }
      return counts;
    },

    async finish(workspaceId, jobs) {
      const finished = await client.begin(async (tx) => {
        const rows = await tx<FinishedRow[]>`SELECT public.sys_workspace_delete_finish(${workspaceId}::uuid) AS finished`;
        const row = rows[0];
        if (rows.length !== 1 || row === undefined) {
          throw new Error("sys_workspace_delete_finish did not return exactly one row");
        }
        if (row.finished) {
          for (const job of jobs) {
            await enqueueInTransaction(tx, job);
          }
        }
        return row.finished;
      });
      return finished;
    },
  };
}

/** Opens a pool as the application role and returns the deletion store on it. The pool connects on first use. */
export function createWorkspaceDeletionStore(options: WorkspaceDeletionStoreOptions): WorkspaceDeletionStore & { close(): Promise<void> } {
  const client = postgres(options.url, {
    max: options.poolSize ?? 1,
    onnotice: () => undefined,
  });
  return {
    ...bindWorkspaceDeletionStore(client),
    close: () => client.end({ timeout: 5 }),
  };
}
