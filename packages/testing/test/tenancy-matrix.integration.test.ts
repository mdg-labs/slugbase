import { listRepositoryMethods, TenantContextError, type RepositoryMethodEntry } from "@slugbase/db";
import { beforeAll, describe, expect, it } from "vitest";
import { useTestDatabase } from "../src/db.ts";
import {
  assertMatrixPassed,
  classifyOperations,
  createProbe,
  loadOpenApiDocument,
  PROBE_WORKSPACE_A,
  PROBE_WORKSPACE_B,
  runApiMatrix,
  runRlsOnlyMatrix,
  type ApiCall,
  type ApiResponse,
  type Probe,
  type TenantFixture,
} from "../src/tenancy.ts";

// The cross-tenant matrix (doc 08 section 3.3, D8, T1, T2). The first suite
// runs it over the committed contract and the scoped-repository registry as
// they are; the others prove it can fail, against a probe table whose policy
// is wrong and against handlers that break the boundary.

const HOOK_TIMEOUT_MS = 300_000;

const database = useTestDatabase();
let scoped: Probe;
let permissive: Probe;
// The tests that write to B get a table of their own.
let victim: Probe;

beforeAll(async () => {
  scoped = await createProbe(database(), { table: "matrix_probe", repository: "matrix_probe" });
  permissive = await createProbe(database(), { table: "matrix_probe_open", repository: "matrix_probe_open", policy: "permissive" });
  victim = await createProbe(database(), { table: "matrix_probe_victim", repository: "matrix_probe_victim" });
}, HOOK_TIMEOUT_MS);

const document = loadOpenApiDocument();
const classification = classifyOperations(document);

describe("the matrix over the committed contract and the repository registry", () => {
  // This package-level test exercises the runner with no server. The API mode
  // over the real middleware chain, through an in-process createServer, runs in
  // packages/server/test/contract/ (matrixRequest), where the answers are held
  // to account. Here a fixed responder stands in for the server, so what the
  // test proves is the runner's own part: the classification of the document
  // and that every tenant-scoped operation is called by every principal of A,
  // the operations that name a member of B (the role change, the removal and the leaving) once for each member of B. The responder answers as the
  // chain does for a member of B: 403 to a token (they declare no scope) and to a plain member where the policy is the admin's (the leaving is a
  // member's), 404 to the rest.
  const answersAsTheChainDoes = (call: ApiCall): Promise<ApiResponse> =>
    Promise.resolve({ status: "scope" in call.principal || (call.principal.role === "member" && call.operation.operationId !== "leaveWorkspace") ? 403 : 404 });

  it(`API mode classifies the ${String(classification.summary.total)} operations of openapi.json and calls each tenant-scoped one once for every principal of A`, async () => {
    const report = await runApiMatrix({ document, fixture: scoped.fixture, request: answersAsTheChainDoes, mapping: { accountId: "member", transferTo: "member" } });
    expect(classification.problems).toEqual([]);
    expect(report.classified.total).toBe(classification.operations.length);
    expect(report.classified.total).toBeGreaterThan(0);
    expect(Object.values(report.classified.byKind).reduce((sum, count) => sum + count, 0)).toBe(report.classified.total);
    // The operations on /workspace (reading, renaming and deleting it) and /workspace/settings and the members list act in the workspace of the request and take no identifier of B;
    // the role change and the removal name a member by account identifier, the removal and the leaving a recipient.
    expect(report.classified.byKind["tenant-scoped"]).toBe(9);
    // Three sessions and six tokens of A, once on each of the six operations that name no member, once for each of the three members of B on the role
    // change and on the leaving, and once for each pair of members of B (path and recipient) on the removal.
    expect(report.attempts).toBe(9 * 6 + 9 * (3 + 3 + 3 * 3));
    assertMatrixPassed(report);
  });

  it("RLS-only mode passes over the scoped-repository registry as it stands", async () => {
    const methods = listRepositoryMethods();
    const report = await runRlsOnlyMatrix({ tenant: database().tenant, fixture: scoped.fixture, methods });
    expect(report.methods).toBe(methods.length);
    assertMatrixPassed(report);
  });
});

describe("RLS-only mode", () => {
  it("passes for a table with a workspace policy: every read and write stays in workspace A", async () => {
    const report = await runRlsOnlyMatrix({
      tenant: database().tenant,
      fixture: scoped.fixture,
      methods: scoped.methods,
      samples: { [scoped.repository]: scoped.sample },
    });
    expect(report.failures).toEqual([]);
    expect(report.methods).toBe(4);
    // select, delete, and an insert and an update each in A and naming B
    expect(report.attempts).toBe(6);
  });

  it("leaves the rows of A and B as it found them", async () => {
    const before = await Promise.all([scoped.fixture.checksum(PROBE_WORKSPACE_A), scoped.fixture.checksum(PROBE_WORKSPACE_B)]);
    await runRlsOnlyMatrix({
      tenant: database().tenant,
      fixture: scoped.fixture,
      methods: scoped.methods,
      samples: { [scoped.repository]: scoped.sample },
    });
    const after = await Promise.all([scoped.fixture.checksum(PROBE_WORKSPACE_A), scoped.fixture.checksum(PROBE_WORKSPACE_B)]);
    expect(after).toEqual(before);
  });

  it("fails for a table whose policy is USING (true)", async () => {
    const report = await runRlsOnlyMatrix({
      tenant: database().tenant,
      fixture: permissive.fixture,
      methods: permissive.methods,
      samples: { [permissive.repository]: permissive.sample },
    });
    const byMethod = new Map(report.failures.map((failure) => [failure.subject.split(" ")[0], failure.kind]));
    expect(byMethod.get("matrix_probe_open.select")).toBe("read_foreign_row");
    // An update and a delete without the workspace predicate reach the rows of B.
    expect(byMethod.get("matrix_probe_open.update")).toBe("wrote_foreign_row");
    expect(byMethod.get("matrix_probe_open.delete")).toBe("wrote_foreign_row");
    // The RLS-only build neither stamps nor refuses an insert naming B: it reaches
    // the table, and the USING (true) WITH CHECK (true) policy lets it in.
    expect(byMethod.get("matrix_probe_open.insert")).toBe("wrote_foreign_row");
    expect(() => {
      assertMatrixPassed(report);
    }).toThrow(/rls-only.*matrix_probe_open\.select/s);
  });

  it("fails a USING (true) WITH CHECK (true) table on the insert naming B alone: the write reaches the table unchanged", async () => {
    const report = await runRlsOnlyMatrix({
      tenant: database().tenant,
      fixture: permissive.fixture,
      methods: permissive.methods.filter((entry) => entry.method === "insert"),
      samples: { [permissive.repository]: permissive.sample },
    });
    expect(report.rlsRefusals).toBe(0);
    expect(report.applicationRefusals).toEqual([]);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toMatchObject({ kind: "wrote_foreign_row" });
    expect(report.failures[0]?.detail).toMatch(/^naming workspace B/);
  });

  it("reports the refusals of a table with a workspace policy as RLS evidence: the RLS-only build makes none of its own", async () => {
    const report = await runRlsOnlyMatrix({
      tenant: database().tenant,
      fixture: scoped.fixture,
      methods: scoped.methods,
      samples: { [scoped.repository]: scoped.sample },
    });
    expect(report.failures).toEqual([]);
    // the insert and the update naming B, each refused by row-level security
    expect(report.rlsRefusals).toBe(2);
    expect(report.applicationRefusals).toEqual([]);
  });

  it("reports a method that refuses a write naming B with the foreign_workspace code as an application refusal, not as RLS evidence", async () => {
    const insert = methodOf(scoped, "insert");
    const entry: RepositoryMethodEntry = {
      ...insert,
      invokeRlsOnly: (tx, input) =>
        input?.values?.["workspaceId"] === PROBE_WORKSPACE_B
          ? Promise.reject(new TenantContextError("foreign_workspace", "refused"))
          : insert.invokeRlsOnly(tx, input),
    };
    const report = await runRlsOnlyMatrix({
      tenant: database().tenant,
      fixture: scoped.fixture,
      methods: [entry],
      samples: { [scoped.repository]: scoped.sample },
    });
    expect(report.failures).toEqual([]);
    expect(report.rlsRefusals).toBe(0);
    expect(report.applicationRefusals).toEqual(["matrix_probe.insert (matrix_probe)"]);
  });

  it("fails an update naming B that touches no row: row-level security was not exercised", async () => {
    const entry: RepositoryMethodEntry = {
      ...methodOf(scoped, "update"),
      invokeRlsOnly: (tx, input) =>
        input?.set?.["workspaceId"] === PROBE_WORKSPACE_B ? Promise.resolve([]) : methodOf(scoped, "update").invokeRlsOnly(tx, input),
    };
    const report = await runRlsOnlyMatrix({
      tenant: database().tenant,
      fixture: scoped.fixture,
      methods: [entry],
      samples: { [scoped.repository]: scoped.sample },
    });
    expect(report.failures.map((failure) => failure.kind)).toEqual(["write_not_exercised"]);
    expect(report.failures[0]?.detail).toMatch(/^naming workspace B/);
  });

  it.each(["insert", "delete"] as const)(
    "fails a %s that changes the rows of B inside its transaction but returns no row: the rolled-back write is invisible to the checksum",
    async (name) => {
      const real = methodOf(permissive, name);
      const entry: RepositoryMethodEntry = {
        ...real,
        invokeRlsOnly: async (tx, input) => {
          await real.invokeRlsOnly(tx, input);
          return [];
        },
      };
      const report = await runRlsOnlyMatrix({
        tenant: database().tenant,
        fixture: permissive.fixture,
        methods: [entry],
        samples: { [permissive.repository]: permissive.sample },
      });
      expect(report.failures.map((failure) => failure.kind)).toEqual(Array(name === "delete" ? 1 : 2).fill("write_not_exercised"));
      expect(() => {
        assertMatrixPassed(report);
      }).toThrow(/write_not_exercised/);
    },
  );

  /** A real row-level-security refusal (SQLSTATE 42501): a row of B written under the transaction of A. */
  async function rowLevelSecurityRefusal(probe: Probe): Promise<Error> {
    try {
      await database().app.begin(async (sql) => {
        await sql`SELECT set_config('app.workspace_id', ${probe.fixture.a.id}, true)`;
        await sql.unsafe(`INSERT INTO ${probe.table} (id, workspace_id, label) VALUES ($1, $2, 'refused')`, [
          "0192f3a0-2222-7000-8000-00000000c0df",
          probe.fixture.b.id,
        ]);
      });
    } catch (error) {
      if (error instanceof Error && (error as { code?: unknown }).code === "42501") {
        return error;
      }
      throw error;
    }
    throw new Error("the database accepted a row of B under the transaction of A");
  }

  function methodOf(probe: Probe, name: RepositoryMethodEntry["method"]): RepositoryMethodEntry {
    const entry = probe.methods.find((candidate) => candidate.method === name);
    if (entry === undefined) {
      throw new Error(`the probe has no ${name} method`);
    }
    return entry;
  }

  it("counts a refusal by row-level security (42501) of a write naming B as a pass, and as RLS evidence", async () => {
    const insert = methodOf(scoped, "insert");
    const refused = await rowLevelSecurityRefusal(scoped);
    const entry: RepositoryMethodEntry = {
      ...insert,
      invokeRlsOnly: (tx, input) => (input?.values?.["workspaceId"] === PROBE_WORKSPACE_B ? Promise.reject(refused) : insert.invokeRlsOnly(tx, input)),
    };
    const report = await runRlsOnlyMatrix({
      tenant: database().tenant,
      fixture: scoped.fixture,
      methods: [entry],
      samples: { [scoped.repository]: scoped.sample },
    });
    expect(report.failures).toEqual([]);
    expect(report.rlsRefusals).toBe(1);
    expect(report.applicationRefusals).toEqual([]);
  });

  it("fails a write in workspace A that is refused, even by row-level security: the method did not run", async () => {
    const insert = methodOf(scoped, "insert");
    const refused = await rowLevelSecurityRefusal(scoped);
    const entry: RepositoryMethodEntry = { ...insert, invokeRlsOnly: () => Promise.reject(refused) };
    const report = await runRlsOnlyMatrix({
      tenant: database().tenant,
      fixture: scoped.fixture,
      methods: [entry],
      samples: { [scoped.repository]: scoped.sample },
    });
    expect(report.failures.map((failure) => `${failure.kind}: ${failure.detail.split(":")[0] ?? ""}`)).toEqual([
      "unexpected_error: in workspace A",
    ]);
  });

  it("fails an attempt naming B that the database rejects with a SQLSTATE other than 42501, though the attempt in A completes", async () => {
    const insert = methodOf(scoped, "insert");
    // Any other five-character SQLSTATE: 23505 (unique_violation) is a constraint, not row-level security.
    const rejected = Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
    const entry: RepositoryMethodEntry = {
      ...insert,
      invokeRlsOnly: (tx, input) => (input?.values?.["workspaceId"] === PROBE_WORKSPACE_B ? Promise.reject(rejected) : insert.invokeRlsOnly(tx, input)),
    };
    const report = await runRlsOnlyMatrix({
      tenant: database().tenant,
      fixture: scoped.fixture,
      methods: [entry],
      samples: { [scoped.repository]: scoped.sample },
    });
    expect(report.failures.map((failure) => `${failure.kind}: ${failure.detail.split(":")[0] ?? ""}`)).toEqual([
      "unexpected_error: naming workspace B",
    ]);
    expect(report.rlsRefusals).toBe(0);
    expect(report.applicationRefusals).toEqual([]);
  });

  it("fails an insert the database rejects for another reason, on a USING (true) table", async () => {
    const report = await runRlsOnlyMatrix({
      tenant: database().tenant,
      fixture: permissive.fixture,
      methods: permissive.methods.filter((entry) => entry.method === "insert"),
      samples: { [permissive.repository]: { ...permissive.sample, values: { id: "not-a-uuid", label: "matrix-probe-rejected" } } },
    });
    expect(report.failures.map((failure) => failure.kind)).toContain("unexpected_error");
    const own = report.failures.find((failure) => failure.detail.startsWith("in workspace A"));
    expect(own?.kind).toBe("unexpected_error");
    expect(own?.detail).toMatch(/uuid/i);
  });

  it.each(["insert", "update", "delete"] as const)(
    "fails a %s that throws a tenant-context error other than the foreign-workspace refusal, for every attempt",
    async (name) => {
      const entry: RepositoryMethodEntry = {
        ...methodOf(scoped, name),
        invokeRlsOnly: () => Promise.reject(new TenantContextError("not_a_tenant_transaction", "not a tenant transaction")),
      };
      const report = await runRlsOnlyMatrix({
        tenant: database().tenant,
        fixture: scoped.fixture,
        methods: [entry],
        samples: { [scoped.repository]: scoped.sample },
      });
      expect(report.failures.map((failure) => failure.kind)).toEqual(Array(name === "delete" ? 1 : 2).fill("unexpected_error"));
      expect(report.applicationRefusals).toEqual([]);
      expect(report.rlsRefusals).toBe(0);
    },
  );

  it("fails a read that throws instead of returning rows", async () => {
    const entry: RepositoryMethodEntry = {
      ...methodOf(scoped, "select"),
      invokeRlsOnly: () => Promise.reject(new TenantContextError("foreign_workspace", "refused")),
    };
    const report = await runRlsOnlyMatrix({ tenant: database().tenant, fixture: scoped.fixture, methods: [entry] });
    expect(report.failures.map((failure) => failure.kind)).toEqual(["unexpected_error"]);
  });

  it("fails a write method whose repository has no sample row", async () => {
    const report = await runRlsOnlyMatrix({ tenant: database().tenant, fixture: scoped.fixture, methods: scoped.methods, samples: {} });
    expect(report.failures.map((failure) => failure.kind)).toEqual(["unmapped_repository", "unmapped_repository"]);
    expect(report.failures[0]?.subject).toContain("matrix_probe.insert");
  });

  it("does not take an unexplained error for a refusal", async () => {
    const [select] = scoped.methods;
    if (select === undefined) {
      throw new Error("the probe has no methods");
    }
    const broken: RepositoryMethodEntry = {
      ...select,
      invokeRlsOnly: () => Promise.reject(new Error("connection lost")),
    };
    const report = await runRlsOnlyMatrix({ tenant: database().tenant, fixture: scoped.fixture, methods: [broken] });
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toMatchObject({ kind: "unexpected_error" });
  });

  it("fails a method that changes B outside the transaction it was given", async () => {
    const [select] = victim.methods;
    if (select === undefined) {
      throw new Error("the probe has no methods");
    }
    const sneaky: RepositoryMethodEntry = {
      ...select,
      method: "delete",
      access: "write",
      invokeRlsOnly: async () => {
        await database().owner.begin(async (tx) => {
          await tx`SELECT set_config('app.workspace_id', ${PROBE_WORKSPACE_B}, true)`;
          await tx.unsafe(`UPDATE ${victim.table} SET label = 'tampered' WHERE workspace_id = $1`, [PROBE_WORKSPACE_B]);
        });
        return [{ workspaceId: PROBE_WORKSPACE_A }];
      },
    };
    const report = await runRlsOnlyMatrix({ tenant: database().tenant, fixture: victim.fixture, methods: [sneaky] });
    expect(report.failures.map((failure) => failure.kind)).toEqual(["workspace_changed"]);
  });
});

// The constructed Critical of doc 10 section 6: GET /api/bookmarks/{id} loads
// the row by id outside the tenant transaction, through a system operation
// that ignores the boundary, and answers an account of workspace A with a row
// of workspace B. Row-level security cannot see it, because the operation does
// not use the tenant transaction; the matrix in API mode has to.
describe("API mode over the probe table", () => {
  const READ_API = {
    openapi: "3.1.0",
    paths: { "/api/v1/bookmarks/{bookmarkId}": { get: { operationId: "getBookmark", "x-slugbase-auth": "member" } } },
  };
  const DELETE_API = {
    openapi: "3.1.0",
    paths: { "/api/v1/bookmarks/{bookmarkId}": { delete: { operationId: "deleteBookmark", "x-slugbase-auth": "member" } } },
  };
  const mapping = { bookmarkId: "bookmark" } as const;

  // The handlers below stand alone, with no chain in front of them to refuse a token that declares no scope; the probe's tokens
  // are exercised over the real chain in the contract tests of @slugbase/server.
  const sessionsOnly = (fixture: TenantFixture): TenantFixture => ({ ...fixture, a: { ...fixture.a, tokens: [] } });

  /** Runs `statement` as the table owner in workspace A and then in B until a row comes back: a system operation that ignores the boundary. */
  async function everywhere(probe: Probe, statement: string, id: string): Promise<Record<string, unknown> | undefined> {
    for (const workspaceId of [probe.fixture.a.id, probe.fixture.b.id]) {
      const rows = await database().owner.begin(async (tx) => {
        await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
        return tx.unsafe<Record<string, unknown>[]>(statement, [id]);
      });
      if (rows[0] !== undefined) {
        return rows[0];
      }
    }
    return undefined;
  }

  /** The handler as it should be: the row is read inside the tenant transaction of the caller's workspace. */
  async function loadInTenant(probe: Probe, call: ApiCall): Promise<ApiResponse> {
    const id = call.targets["bookmarkId"];
    const [select] = probe.methods;
    if (select === undefined) {
      throw new Error("the probe has no methods");
    }
    const rows = await database().tenant.withTenant(
      { accountId: call.principal.accountId, workspaceId: probe.fixture.a.id, requestId: "api-mode" },
      (tx) => select.invoke(tx),
    );
    const row = rows.find((candidate) => (candidate as { id?: string }).id === id);
    return row === undefined ? { status: 404, body: { title: "Not Found", instance: call.url } } : { status: 200, body: row };
  }

  it("passes a handler that reads inside the tenant transaction", async () => {
    const report = await runApiMatrix({
      document: READ_API,
      fixture: sessionsOnly(scoped.fixture),
      mapping,
      request: (call) => loadInTenant(scoped, call),
    });
    expect(report.failures).toEqual([]);
    // three principals of A against the shared and the unshared bookmark of B
    expect(report.attempts).toBe(6);
  });

  it("detects the endpoint that loads a row by id outside the tenant transaction", async () => {
    const report = await runApiMatrix({
      document: READ_API,
      fixture: sessionsOnly(scoped.fixture),
      mapping,
      request: async (call) => {
        const row = await everywhere(scoped, `SELECT * FROM ${scoped.table} WHERE id = $1`, call.targets["bookmarkId"] ?? "");
        return row === undefined ? { status: 404 } : { status: 200, body: row };
      },
    });
    expect(new Set(report.failures.map((failure) => failure.kind))).toEqual(new Set(["unexpected_status", "leaked_name"]));
    expect(report.failures.every((failure) => failure.subject.includes("getBookmark"))).toBe(true);
    expect(report.failures.filter((failure) => failure.kind === "unexpected_status")).toHaveLength(6);
  });

  it("detects the same endpoint changing a row of B, by the checksum, even when it answers 404", async () => {
    const report = await runApiMatrix({
      document: DELETE_API,
      fixture: sessionsOnly(victim.fixture),
      mapping,
      request: async (call) => {
        await everywhere(victim, `DELETE FROM ${victim.table} WHERE id = $1 RETURNING *`, call.targets["bookmarkId"] ?? "");
        return { status: 404 };
      },
    });
    // the first attempt against each of the two rows removes it
    expect(report.failures.map((failure) => failure.kind)).toEqual(["workspace_changed", "workspace_changed"]);
    expect(report.failures[0]?.subject).toContain("deleteBookmark");
  });
});
