import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listRepositoryMethods } from "../src/repositories/registry.ts";
import { defineScopedRepository } from "../src/repositories/scoped.ts";
import { bindTenantDatabase, tenantHandle, type TenantContext, type TenantTx } from "../src/tenant.ts";
import { createTestDatabase, testRepositoryMethods, type TestDatabase } from "../src/testing.ts";
import {
  ACCOUNT_A,
  createProbeTables,
  ownerIn,
  ownerRows as readOwnerRows,
  probe,
  probeOpen,
  ROW_A,
  ROW_B,
  seedProbeRows,
  WORKSPACE_A,
  WORKSPACE_B,
} from "./support/tenant-fixture.ts";

// The scoped repositories and row-level security on a test-only table with a
// forced policy (doc 01 section 5.3 and 5.4, doc 10 T1, D8): the predicate of
// the repository and the policy of the database each keep workspace B out of
// workspace A's transaction, and the second does so alone.

const HOOK_TIMEOUT_MS = 300_000;

let database: TestDatabase;
const probes = defineScopedRepository("probe", probe);
const openProbes = defineScopedRepository("probe_open", probeOpen);

const inA: TenantContext = { accountId: ACCOUNT_A, workspaceId: WORKSPACE_A, requestId: "repo-a" };

beforeAll(async () => {
  database = await createTestDatabase();
  await createProbeTables(database);
  await seedProbeRows(database);
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await database.drop();
}, HOOK_TIMEOUT_MS);

const tenant = () => bindTenantDatabase(database.app);

class RolledBack extends Error {
  readonly rows: readonly unknown[];
  constructor(rows: readonly unknown[]) {
    super("rolled back");
    this.rows = rows;
  }
}

/** Runs `work` in withTenant(A) and rolls the transaction back, returning what `work` returned or the error it raised. */
async function rolledBack(
  work: (tx: TenantTx) => Promise<readonly unknown[]>,
  context: TenantContext = inA,
): Promise<{ rows: readonly unknown[] } | { error: unknown }> {
  try {
    await database.tenant.withTenant(context, async (tx) => {
      throw new RolledBack(await work(tx));
    });
  } catch (error) {
    return error instanceof RolledBack ? { rows: error.rows } : { error };
  }
  throw new Error("withTenant returned instead of rolling back");
}

/** The SQLSTATE of an error, looking through the causes the query builder wraps it in. */
function sqlstate(error: unknown, depth = 0): string | undefined {
  if (typeof error !== "object" || error === null || depth > 4) {
    return undefined;
  }
  const { code, cause } = error as { code?: unknown; cause?: unknown };
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : sqlstate(cause, depth + 1);
}

const ownerRows = (table: string) => readOwnerRows(database, table);

describe("a query outside withTenant", () => {
  it("returns zero rows from the table with forced row-level security (fails closed)", async () => {
    const rows = await database.app.unsafe("SELECT id FROM tenant_probe");
    expect(rows).toHaveLength(0);
    expect(await ownerRows("tenant_probe")).toHaveLength(2);
  });

  it("updates and deletes nothing", async () => {
    const updated = await database.app.unsafe("UPDATE tenant_probe SET label = 'x' RETURNING id");
    const deleted = await database.app.unsafe("DELETE FROM tenant_probe RETURNING id");
    expect(updated).toHaveLength(0);
    expect(deleted).toHaveLength(0);
    expect((await ownerRows("tenant_probe")).map((row) => row.label)).toEqual(["a", "b"]);
  });

  it("refuses an insert", async () => {
    await expect(
      database.app.unsafe("INSERT INTO tenant_probe (id, workspace_id, label) VALUES (gen_random_uuid(), $1, 'x')", [
        WORKSPACE_A,
      ]),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

describe("inside withTenant(A)", () => {
  it("reads only the rows of workspace A", async () => {
    const rows = await tenant().withTenant(inA, (tx) => probes.bind(tx).select());
    expect(rows.map((row) => row.id)).toEqual([ROW_A]);
  });

  it("finds nothing of workspace B by id", async () => {
    const rows = await tenant().withTenant(inA, (tx) => probes.bind(tx).select(eq(probe.id, ROW_B)));
    expect(rows).toEqual([]);
  });

  it("updates nothing of workspace B", async () => {
    const rows = await tenant().withTenant(inA, (tx) => probes.bind(tx).update({ label: "changed" }, eq(probe.id, ROW_B)));
    expect(rows).toEqual([]);
    expect((await ownerRows("tenant_probe")).find((row) => row.id === ROW_B)?.label).toBe("b");
  });

  it("deletes nothing of workspace B", async () => {
    const rows = await tenant().withTenant(inA, (tx) => probes.bind(tx).delete(eq(probe.id, ROW_B)));
    expect(rows).toEqual([]);
    expect(await ownerRows("tenant_probe")).toHaveLength(2);
  });

  it("stamps an insert with the workspace of the transaction", async () => {
    const id = "0192f3a0-2222-7000-8000-0000000000c1";
    const row = await tenant().withTenant(inA, (tx) => probes.bind(tx).insert({ id, label: "new" }));
    expect(row.workspaceId).toBe(WORKSPACE_A);
    await ownerIn(database, WORKSPACE_A, "DELETE FROM tenant_probe WHERE id = $1", [id]);
  });

  it("accepts an insert that names its own workspace and refuses one that names another", async () => {
    const id = "0192f3a0-2222-7000-8000-0000000000c2";
    await tenant().withTenant(inA, async (tx) => {
      const row = await probes.bind(tx).insert({ id, label: "own", workspaceId: WORKSPACE_A.toUpperCase() });
      expect(row.workspaceId).toBe(WORKSPACE_A);
    });
    await expect(
      tenant().withTenant(inA, (tx) =>
        probes.bind(tx).insert({ id: "0192f3a0-2222-7000-8000-0000000000c3", label: "x", workspaceId: WORKSPACE_B }),
      ),
    ).rejects.toMatchObject({ name: "TenantContextError", code: "foreign_workspace" });
    expect((await ownerRows("tenant_probe")).filter((row) => row.workspace_id === WORKSPACE_B)).toHaveLength(1);
    await ownerIn(database, WORKSPACE_A, "DELETE FROM tenant_probe WHERE id = $1", [id]);
  });

  it("refuses an update that would move a row to another workspace", async () => {
    await expect(
      tenant().withTenant(inA, (tx) => probes.bind(tx).update({ workspaceId: WORKSPACE_B }, eq(probe.id, ROW_A))),
    ).rejects.toMatchObject({ code: "foreign_workspace" });
    expect((await ownerRows("tenant_probe")).find((row) => row.id === ROW_A)?.workspace_id).toBe(WORKSPACE_A);
  });

  it("updates and deletes the rows of workspace A", async () => {
    await tenant().withTenant(inA, async (tx) => {
      const repository = probes.bind(tx);
      const updated = await repository.update({ label: "a2" }, eq(probe.id, ROW_A));
      expect(updated.map((row) => row.label)).toEqual(["a2"]);
      expect((await repository.delete(eq(probe.id, ROW_A))).map((row) => row.id)).toEqual([ROW_A]);
    });
    await ownerIn(database, WORKSPACE_A, "INSERT INTO tenant_probe (id, workspace_id, label) VALUES ($1, $2, 'a')", [
      ROW_A,
      WORKSPACE_A,
    ]);
  });

  it("refuses a scoped repository in an account-level transaction", async () => {
    await expect(
      tenant().withTenant({ accountId: ACCOUNT_A, requestId: "acct" }, (tx) => probes.bind(tx).select()),
    ).rejects.toMatchObject({ code: "workspace_required" });
  });
});

describe("the predicate of the repository itself (on the table without row-level security)", () => {
  it("reads only the rows of workspace A, also by the id of a row of B", async () => {
    const all = await tenant().withTenant(inA, (tx) => openProbes.bind(tx).select());
    const byId = await tenant().withTenant(inA, (tx) => openProbes.bind(tx).select(eq(probeOpen.id, ROW_B)));
    expect(all.map((row) => row.id)).toEqual([ROW_A]);
    expect(byId).toEqual([]);
  });

  it("updates and deletes nothing of workspace B", async () => {
    const updated = await tenant().withTenant(inA, (tx) =>
      openProbes.bind(tx).update({ label: "changed" }, eq(probeOpen.id, ROW_B)),
    );
    const deleted = await tenant().withTenant(inA, (tx) => openProbes.bind(tx).delete(eq(probeOpen.id, ROW_B)));
    expect(updated).toEqual([]);
    expect(deleted).toEqual([]);
    expect((await ownerRows("tenant_probe_open")).map((row) => row.label)).toEqual(["a", "b"]);
  });

  it("keeps the workspace predicate when the caller predicate has a top-level OR", async () => {
    const reachesB = sql`false or ${probeOpen.id} = ${ROW_B}`;
    const selected = await tenant().withTenant(inA, (tx) => openProbes.bind(tx).select(reachesB));
    const updated = await tenant().withTenant(inA, (tx) => openProbes.bind(tx).update({ label: "hit" }, reachesB));
    const deleted = await tenant().withTenant(inA, (tx) => openProbes.bind(tx).delete(reachesB));
    expect(selected).toEqual([]);
    expect(updated).toEqual([]);
    expect(deleted).toEqual([]);
    expect((await ownerRows("tenant_probe_open")).map((row) => row.label)).toEqual(["a", "b"]);
  });

  it("stamps an insert with the workspace of the transaction", async () => {
    const id = "0192f3a0-2222-7000-8000-0000000000d1";
    const row = await tenant().withTenant(inA, (tx) => openProbes.bind(tx).insert({ id, label: "new" }));
    expect(row.workspaceId).toBe(WORKSPACE_A);
    await ownerIn(database, WORKSPACE_A, "DELETE FROM tenant_probe_open WHERE id = $1", [id]);
  });
});

describe("with the workspace predicate removed (T1: row-level security alone holds)", () => {
  const entry = (repository: string, method: string) => {
    const found = listRepositoryMethods().find((e) => e.repository === repository && e.method === method);
    if (found === undefined) {
      throw new Error(`no registry entry ${repository}.${method}`);
    }
    return found;
  };

  it("reads no row of workspace B, with no predicate and with B's id", async () => {
    const all = await tenant().withTenant(inA, (tx) => entry("probe", "select").invokeRlsOnly(tx));
    const byId = await tenant().withTenant(inA, (tx) =>
      entry("probe", "select").invokeRlsOnly(tx, { where: eq(probe.id, ROW_B) }),
    );
    expect(all).toHaveLength(1);
    expect(byId).toEqual([]);
  });

  it("updates and deletes no row of workspace B", async () => {
    const updated = await tenant().withTenant(inA, (tx) =>
      entry("probe", "update").invokeRlsOnly(tx, { set: { label: "changed" }, where: eq(probe.id, ROW_B) }),
    );
    const deleted = await tenant().withTenant(inA, (tx) =>
      entry("probe", "delete").invokeRlsOnly(tx, { where: eq(probe.id, ROW_B) }),
    );
    expect(updated).toEqual([]);
    expect(deleted).toEqual([]);
    expect((await ownerRows("tenant_probe")).find((row) => row.id === ROW_B)?.label).toBe("b");
  });

  it("is a test that can fail: on the table without row-level security the same query reads workspace B", async () => {
    const leaked = await tenant().withTenant(inA, (tx) => entry("probe_open", "select").invokeRlsOnly(tx));
    expect(leaked).toHaveLength(2);
    const scoped = await tenant().withTenant(inA, (tx) => entry("probe_open", "select").invoke(tx));
    expect(scoped).toHaveLength(1);
    const direct = await tenant().withTenant(inA, (tx) => openProbes.bind(tx).select());
    expect(direct).toHaveLength(1);
  });
});

describe("the RLS-only build drops the application layer as well as the predicate (T1)", () => {
  const entry = (repository: string, method: string) => {
    const found = listRepositoryMethods().find((e) => e.repository === repository && e.method === method);
    if (found === undefined) {
      throw new Error(`no registry entry ${repository}.${method}`);
    }
    return found;
  };
  const NEW_ID = "0192f3a0-2222-7000-8000-0000000000e1";

  it("hands an insert naming workspace B to the database, which refuses it by row-level security (42501)", async () => {
    const outcome = await rolledBack((tx) =>
      entry("probe", "insert").invokeRlsOnly(tx, { values: { id: NEW_ID, label: "x", workspaceId: WORKSPACE_B } }),
    );
    expect("error" in outcome && sqlstate(outcome.error)).toBe("42501");
  });

  it("hands an update naming workspace B to the database, which refuses it by row-level security (42501)", async () => {
    const outcome = await rolledBack((tx) =>
      entry("probe", "update").invokeRlsOnly(tx, { set: { label: "x", workspaceId: WORKSPACE_B } }),
    );
    expect("error" in outcome && sqlstate(outcome.error)).toBe("42501");
    expect((await ownerRows("tenant_probe")).map((row) => row.workspace_id)).toEqual([WORKSPACE_A, WORKSPACE_B]);
  });

  it("does not stamp an insert: a row without a workspace reaches the database and fails its NOT NULL (23502)", async () => {
    const outcome = await rolledBack((tx) => entry("probe_open", "insert").invokeRlsOnly(tx, { values: { id: NEW_ID, label: "x" } }));
    expect("error" in outcome && sqlstate(outcome.error)).toBe("23502");
  });

  it("writes the workspace it is given on a table without row-level security: nothing but the policy could have refused it", async () => {
    const inserted = await rolledBack((tx) =>
      entry("probe_open", "insert").invokeRlsOnly(tx, { values: { id: NEW_ID, label: "x", workspaceId: WORKSPACE_B } }),
    );
    expect("rows" in inserted && inserted.rows).toMatchObject([{ id: NEW_ID, workspaceId: WORKSPACE_B }]);
    const moved = await rolledBack((tx) =>
      entry("probe_open", "update").invokeRlsOnly(tx, { set: { workspaceId: WORKSPACE_B }, where: eq(probeOpen.id, ROW_A) }),
    );
    expect("rows" in moved && moved.rows).toMatchObject([{ id: ROW_A, workspaceId: WORKSPACE_B }]);
    expect((await ownerRows("tenant_probe_open")).map((row) => row.workspace_id)).toEqual([WORKSPACE_A, WORKSPACE_B]);
  });

  it("is a test that can fail: the normal build of the same methods stamps and refuses with foreign_workspace before the database", async () => {
    const stamped = await rolledBack((tx) => entry("probe_open", "insert").invoke(tx, { values: { id: NEW_ID, label: "x" } }));
    expect("rows" in stamped && stamped.rows).toMatchObject([{ id: NEW_ID, workspaceId: WORKSPACE_A }]);
    for (const [repository, method, input] of [
      ["probe_open", "insert", { values: { id: NEW_ID, label: "x", workspaceId: WORKSPACE_B } }],
      ["probe_open", "update", { set: { workspaceId: WORKSPACE_B } }],
      ["probe", "insert", { values: { id: NEW_ID, label: "x", workspaceId: WORKSPACE_B } }],
    ] as const) {
      const outcome = await rolledBack((tx) => entry(repository, method).invoke(tx, input));
      expect("error" in outcome && outcome.error).toMatchObject({ name: "TenantContextError", code: "foreign_workspace" });
    }
  });
});

describe("TestDatabase.tenant", () => {
  it("is withTenant bound to the application pool: it validates the context, sets the settings and refuses a nested mismatch", async () => {
    await expect(
      database.tenant.withTenant({ ...inA, workspaceId: "not-a-uuid" }, () => Promise.resolve()),
    ).rejects.toMatchObject({ name: "TenantContextError", code: "invalid_workspace_id" });
    const rows = await database.tenant.withTenant(inA, (tx) => probes.bind(tx).select());
    expect(rows.map((row) => row.id)).toEqual([ROW_A]);
    await expect(
      database.tenant.withTenant(inA, () =>
        database.tenant.withTenant({ ...inA, workspaceId: WORKSPACE_B }, () => Promise.resolve()),
      ),
    ).rejects.toMatchObject({ code: "nested_context_mismatch" });
  });

  it("runs as slugbase_app: a statement outside the tenant transaction sees no row of the forced table", async () => {
    expect(await database.app.unsafe("SELECT id FROM tenant_probe")).toHaveLength(0);
    const rows = await database.tenant.withTenant(inA, (tx) => probes.bind(tx).select());
    expect(rows).toHaveLength(1);
  });
});

describe("testRepositoryMethods", () => {
  it("builds the four methods over a table without entering them in the registry", async () => {
    const before = listRepositoryMethods().length;
    const methods = testRepositoryMethods("helper", "tenant_probe");
    expect(methods.map((e) => [e.repository, e.method, e.access, e.table])).toEqual([
      ["helper", "select", "read", "tenant_probe"],
      ["helper", "insert", "write", "tenant_probe"],
      ["helper", "update", "write", "tenant_probe"],
      ["helper", "delete", "write", "tenant_probe"],
    ]);
    expect(listRepositoryMethods()).toHaveLength(before);
    expect(listRepositoryMethods().some((e) => e.repository === "helper")).toBe(false);
    const select = methods[0];
    const rows = await database.tenant.withTenant(inA, (tx) => select?.invokeRlsOnly(tx) ?? Promise.resolve([]));
    expect(rows).toHaveLength(1);
  });

  it("refuses a table name that is not a lower-case identifier", () => {
    expect(() => testRepositoryMethods("helper", "Tenant Probe; drop")).toThrow(/lower-case SQL identifier/);
  });
});

describe("the registry", () => {
  it("lists select, insert, update and delete of each repository with their access", () => {
    const mine = listRepositoryMethods().filter((e) => e.repository === "probe");
    expect(mine.map((e) => [e.method, e.access, e.table])).toEqual([
      ["select", "read", "tenant_probe"],
      ["insert", "write", "tenant_probe"],
      ["update", "write", "tenant_probe"],
      ["delete", "write", "tenant_probe"],
    ]);
  });
});

describe("the raw handle", () => {
  it("is not reachable from the transaction a service receives", async () => {
    await tenant().withTenant(inA, (tx) => {
      expect(Object.keys(tx).sort()).toEqual(["accountId", "requestId", "workspaceId"]);
      expect(typeof tenantHandle(tx).execute).toBe("function");
      return Promise.resolve();
    });
  });
});
