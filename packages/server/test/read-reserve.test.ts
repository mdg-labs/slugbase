import type { Database } from "@slugbase/db";
import { describe, expect, it } from "vitest";
import { createMetrics } from "../src/metrics/index.ts";
import { READ_RESERVE, createReadReserve } from "../src/read-reserve.ts";
import { sample } from "./metrics/support.ts";

// The read reserve of the tenant pool (doc 01 section 9.2) with a `withTenant` whose transactions end when the test says so: a pool of five connections and a
// reserve of three leave two places for the transactions of requests that write.

const CONTEXT = { accountId: "0192f3a0-bbbb-7000-8000-000000000001", workspaceId: "0192f3a0-bbbb-7000-8000-000000000002", requestId: "reserve-test" };
const TX = Object.freeze({ accountId: CONTEXT.accountId, workspaceId: CONTEXT.workspaceId, requestId: CONTEXT.requestId });

interface Held {
  readonly name: string;
  finish(): void;
  fail(error: Error): void;
}

/** A `withTenant` whose transaction opens at once and ends when its `Held` is finished (at once for a name `autoFinish` accepts); `opened` names the transactions in the order they opened. */
function fakeTenant(autoFinish: (name: string) => boolean = () => false): { readonly withTenant: Database["withTenant"]; readonly opened: string[]; readonly held: Map<string, Held>; open: () => number } {
  const opened: string[] = [];
  const held = new Map<string, Held>();
  let open = 0;
  const withTenant: Database["withTenant"] = async (context, fn) => {
    const name = context.requestId;
    opened.push(name);
    open += 1;
    try {
      const gate = Promise.withResolvers<undefined>();
      held.set(name, { name, finish: () => { gate.resolve(undefined); }, fail: (error) => { gate.reject(error); } });
      if (autoFinish(name)) {
        gate.resolve(undefined);
      }
      const outcome = await fn(TX);
      await gate.promise;
      return outcome;
    } finally {
      open -= 1;
    }
  };
  return { withTenant, opened, held, open: () => open };
}

const named = (requestId: string) => ({ ...CONTEXT, requestId });

/** Lets every promise that can settle without a timer or a database settle. */
const settle = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

function setup(autoFinish?: (name: string) => boolean) {
  const reserve = createReadReserve({ poolSize: 5, reserve: 3 });
  const tenant = fakeTenant(autoFinish);
  const withTenant = reserve.limit(tenant.withTenant);
  const request = <T>(method: string, run: () => Promise<T>): Promise<T> => reserve.inRequest(method, run);
  const finish = (name: string): void => {
    tenant.held.get(name)?.finish();
  };
  return { reserve, tenant, withTenant, request, finish };
}

describe("the read reserve", () => {
  it("is three of the ten connections the server's pool has", () => {
    expect(READ_RESERVE).toBe(3);
  });

  it("lets the transactions of requests that write take the pool less the reserve and holds the next ones, in arrival order, until one ends", async () => {
    const { tenant, withTenant, request, finish } = setup();

    const writers = ["a", "b", "c", "d"].map((name) => request("POST", () => withTenant(named(name), () => Promise.resolve(name))));
    await settle();

    expect(tenant.opened).toEqual(["a", "b"]);
    finish("a");
    await settle();
    expect(tenant.opened).toEqual(["a", "b", "c"]);
    finish("b");
    await settle();
    expect(tenant.opened).toEqual(["a", "b", "c", "d"]);
    finish("c");
    finish("d");
    expect(await Promise.all(writers)).toEqual(["a", "b", "c", "d"]);
  });

  it("never holds a GET or a HEAD, nor a transaction outside a request, however many writers wait", async () => {
    const { tenant, withTenant, request, finish } = setup();
    const writers = ["w1", "w2", "w3"].map((name) => request("PATCH", () => withTenant(named(name), () => Promise.resolve(name))));
    await settle();
    expect(tenant.opened).toEqual(["w1", "w2"]);

    const reads = [
      request("GET", () => withTenant(named("get"), () => Promise.resolve("get"))),
      request("HEAD", () => withTenant(named("head"), () => Promise.resolve("head"))),
      request("get", () => withTenant(named("lowercase"), () => Promise.resolve("lowercase"))),
      withTenant(named("worker"), () => Promise.resolve("worker")),
    ];
    await settle();

    expect(tenant.opened).toEqual(["w1", "w2", "get", "head", "lowercase", "worker"]);
    for (const name of ["get", "head", "lowercase", "worker", "w1", "w2", "w3"]) {
      finish(name);
      await settle();
    }
    expect(await Promise.all([...reads, ...writers])).toEqual(["get", "head", "lowercase", "worker", "w1", "w2", "w3"]);
  });

  it("holds a request that is neither a GET nor a HEAD, whatever its method", async () => {
    const { tenant, withTenant, request } = setup();
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      void request(method, () => withTenant(named(method), () => Promise.resolve(method)));
    }
    await settle();
    expect(tenant.opened).toEqual(["POST", "PUT"]);
  });

  it("does not count a call that joins an open transaction, so a writer inside one is never held by the writers outside it", async () => {
    const { tenant, withTenant, request, finish } = setup((name) => name.startsWith("inner"));
    // The second place is taken by another request, so the one under test has the last place, and its nested calls must not ask for another.
    const other = request("POST", () => withTenant(named("other"), () => Promise.resolve("other")));
    const nestedNames = ["inner-1", "inner-2", "inner-3"];
    const outer = request("POST", () =>
      withTenant(named("outer"), async () => {
        for (const name of nestedNames) {
          await withTenant(named(name), () => Promise.resolve(name));
        }
        return "outer";
      }),
    );
    await settle();

    // The nested calls ran (and are named by the fake as transactions of their own, which the real withTenant would join), none of them waited for a place.
    expect(tenant.opened).toEqual(["other", "outer", ...nestedNames]);
    finish("outer");
    finish("other");
    expect(await Promise.all([other, outer])).toEqual(["other", "outer"]);
  });

  it("gives its place back when the transaction fails, so the writers behind it go on", async () => {
    const { tenant, withTenant, request, finish } = setup();
    const failing = request("POST", () => withTenant(named("failing"), () => Promise.resolve("failing")));
    const second = request("POST", () => withTenant(named("second"), () => Promise.resolve("second")));
    const third = request("POST", () => withTenant(named("third"), () => Promise.resolve("third")));
    await settle();
    expect(tenant.opened).toEqual(["failing", "second"]);

    tenant.held.get("failing")?.fail(new Error("the transaction failed"));
    await expect(failing).rejects.toThrow("the transaction failed");
    await settle();

    expect(tenant.opened).toEqual(["failing", "second", "third"]);
    finish("second");
    finish("third");
    expect(await Promise.all([second, third])).toEqual(["second", "third"]);
  });

  it("is counted by slugbase_db_tenant_transactions_in_flight while it waits for a place, as every other transaction is", async () => {
    const metrics = createMetrics();
    const reserve = createReadReserve({ poolSize: 5, reserve: 3 });
    const tenant = fakeTenant();
    const withTenant = metrics.instrumentTenant(reserve.limit(tenant.withTenant));
    const scrape = async (): Promise<number | undefined> => sample(await metrics.registry.render(), "slugbase_db_tenant_transactions_in_flight");

    const writers = ["a", "b", "c", "d"].map((name) => reserve.inRequest("POST", () => withTenant(named(name), () => Promise.resolve(name))));
    const read = reserve.inRequest("GET", () => withTenant(named("read"), () => Promise.resolve("read")));
    await settle();

    expect([...tenant.opened].sort()).toEqual(["a", "b", "read"]);
    expect(tenant.open()).toBe(3);
    expect(await scrape()).toBe(5);

    for (const name of ["a", "b", "read", "c", "d"]) {
      tenant.held.get(name)?.finish();
      await settle();
    }
    await Promise.all([...writers, read]);
    expect(await scrape()).toBe(0);
  });

  it("refuses a pool that the reserve leaves no place in", () => {
    expect(() => createReadReserve({ poolSize: 3, reserve: 3 })).toThrow("larger than the reserve");
    expect(() => createReadReserve({ poolSize: 10, reserve: 0 })).toThrow("at least one");
  });
});
