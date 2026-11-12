import { AsyncLocalStorage } from "node:async_hooks";
import type { Database } from "@slugbase/db";

// The read reserve of the server's tenant pool (doc 01 section 9.2). A transaction that waits for a row lock keeps its connection, so as many writers waiting
// on one workspace's row as the pool has connections (the creates and deletes that queue behind an import, which holds the row until it commits) leave no
// connection to the reads of any other workspace. The outermost tenant transaction of a request that is not a GET or a HEAD therefore takes a place first, and
// only `poolSize - reserve` places exist: a writer past that waits in memory, in arrival order, holding no connection, so at least `reserve` connections are
// always free for the reads and for the transactions that are not a request's (the worker's, the shutdown's, a start-up check's).
// The places are also counted per workspace: one workspace's writers may hold only `workspaceWriters` of them at once, so a lock held in one workspace idles at
// most that many connections and the other workspaces' writers keep the rest of the places.

/** The connections of the pool no request that writes may take: a constant, not a setting. */
export const READ_RESERVE = 3;

/** The writers of one workspace that may hold a place at once: the one that holds the workspace's row and the one ready to take it. A constant, not a setting. */
export const WORKSPACE_WRITERS = 2;

type WithTenant = Database["withTenant"];

export interface ReadReserve {
  /** Runs `serve` as the handling of a request with this method: the tenant transactions it opens are judged by it. */
  inRequest<T>(method: string, serve: () => T): T;
  /** `withTenant` with the reserve in front of it. A transaction opened inside another one joins it and is not counted. */
  limit(withTenant: WithTenant): WithTenant;
  /** The writers that wait in memory, for a place of their workspace or for one of the pool's. */
  waiting(): number;
}

const READ_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

/** A set of places handed out in arrival order. */
interface Places {
  take(): Promise<void>;
  give(): boolean;
}

export function createReadReserve({
  poolSize,
  reserve = READ_RESERVE,
  workspaceWriters = WORKSPACE_WRITERS,
}: {
  readonly poolSize: number;
  readonly reserve?: number;
  readonly workspaceWriters?: number;
}): ReadReserve {
  const places = poolSize - reserve;
  if (!Number.isInteger(places) || places < 1 || reserve < 1) {
    throw new Error("the read reserve needs a pool larger than the reserve, and a reserve of at least one connection");
  }
  if (!Number.isInteger(workspaceWriters) || workspaceWriters < 1) {
    throw new Error("the read reserve needs a workspace to have at least one place");
  }
  const requests = new AsyncLocalStorage<{ readonly reads: boolean }>();
  // Set while a tenant transaction is open, so that a call in it, which joins that transaction, is not counted again.
  const open = new AsyncLocalStorage<true>();
  let waitingWriters = 0;

  const placesOf = (count: number): Places => {
    const waiting: (() => void)[] = [];
    let taken = 0;
    return {
      take() {
        if (taken < count) {
          taken += 1;
          return Promise.resolve();
        }
        waitingWriters += 1;
        return new Promise<void>((resolve) => {
          waiting.push(() => {
            waitingWriters -= 1;
            resolve();
          });
        });
      },
      // The place goes straight to the writer that has waited longest; `taken` stays as it is. True when no place is taken any more.
      give() {
        const next = waiting.shift();
        if (next === undefined) {
          taken -= 1;
          return taken === 0;
        }
        next();
        return false;
      },
    };
  };

  const pool = placesOf(places);
  const workspaces = new Map<string, Places>();

  const takeWorkspace = (workspaceId: string): Promise<void> => {
    let workspace = workspaces.get(workspaceId);
    if (workspace === undefined) {
      workspace = placesOf(workspaceWriters);
      workspaces.set(workspaceId, workspace);
    }
    return workspace.take();
  };

  const giveWorkspace = (workspaceId: string): void => {
    if (workspaces.get(workspaceId)?.give() === true) {
      workspaces.delete(workspaceId);
    }
  };

  return {
    inRequest: (method, serve) => requests.run({ reads: READ_METHODS.has(method.toUpperCase()) }, serve),

    waiting: () => waitingWriters,

    limit(withTenant) {
      return async (context, fn) => {
        if (open.getStore() === true) {
          return withTenant(context, fn);
        }
        const request = requests.getStore();
        if (request === undefined || request.reads) {
          return open.run(true, () => withTenant(context, fn));
        }
        const { workspaceId } = context;
        if (workspaceId !== undefined) {
          await takeWorkspace(workspaceId);
        }
        try {
          await pool.take();
          try {
            return await open.run(true, () => withTenant(context, fn));
          } finally {
            pool.give();
          }
        } finally {
          if (workspaceId !== undefined) {
            giveWorkspace(workspaceId);
          }
        }
      };
    },
  };
}
