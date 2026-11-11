import { AsyncLocalStorage } from "node:async_hooks";
import type { Database } from "@slugbase/db";

// The read reserve of the server's tenant pool (doc 01 section 9.2). A transaction that waits for a row lock keeps its connection, so as many writers waiting
// on one workspace's row as the pool has connections (the creates and deletes that queue behind an import, which holds the row until it commits) leave no
// connection to the reads of any other workspace. The outermost tenant transaction of a request that is not a GET or a HEAD therefore takes a place first, and
// only `poolSize - reserve` places exist: a writer past that waits in memory, in arrival order, holding no connection, so at least `reserve` connections are
// always free for the reads and for the transactions that are not a request's (the worker's, the shutdown's, a start-up check's).

/** The connections of the pool no request that writes may take: a constant, not a setting. */
export const READ_RESERVE = 3;

type WithTenant = Database["withTenant"];

export interface ReadReserve {
  /** Runs `serve` as the handling of a request with this method: the tenant transactions it opens are judged by it. */
  inRequest<T>(method: string, serve: () => T): T;
  /** `withTenant` with the reserve in front of it. A transaction opened inside another one joins it and is not counted. */
  limit(withTenant: WithTenant): WithTenant;
}

const READ_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

export function createReadReserve({ poolSize, reserve = READ_RESERVE }: { readonly poolSize: number; readonly reserve?: number }): ReadReserve {
  const places = poolSize - reserve;
  if (!Number.isInteger(places) || places < 1 || reserve < 1) {
    throw new Error("the read reserve needs a pool larger than the reserve, and a reserve of at least one connection");
  }
  const requests = new AsyncLocalStorage<{ readonly reads: boolean }>();
  // Set while a tenant transaction is open, so that a call in it, which joins that transaction, is not counted again.
  const open = new AsyncLocalStorage<true>();
  const waiting: (() => void)[] = [];
  let taken = 0;

  const take = (): Promise<void> => {
    if (taken < places) {
      taken += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      waiting.push(resolve);
    });
  };

  // The place goes straight to the writer that has waited longest; `taken` stays as it is.
  const give = (): void => {
    const next = waiting.shift();
    if (next === undefined) {
      taken -= 1;
    } else {
      next();
    }
  };

  return {
    inRequest: (method, serve) => requests.run({ reads: READ_METHODS.has(method.toUpperCase()) }, serve),

    limit(withTenant) {
      return async (context, fn) => {
        if (open.getStore() === true) {
          return withTenant(context, fn);
        }
        const request = requests.getStore();
        if (request === undefined || request.reads) {
          return open.run(true, () => withTenant(context, fn));
        }
        await take();
        try {
          return await open.run(true, () => withTenant(context, fn));
        } finally {
          give();
        }
      };
    },
  };
}
