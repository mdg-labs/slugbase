import { sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bindTenantDatabase, tenantHandle, type TenantContext } from "../src/tenant.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { ACCOUNT_A, ACCOUNT_B, createProbeTables, seedProbeRows, WORKSPACE_A, WORKSPACE_B } from "./support/tenant-fixture.ts";

// The tenant context behind PgBouncer in transaction mode with a server pool of
// one connection (doc 01 section 9.2, doc 08 section 3.2, T1): every client of
// the test database is served by the same Postgres backend, one transaction at a
// time, so a setting that outlives its transaction is met by the next request.
// The file runs only where SLUGBASE_TEST_POOLER_URL names the pooler
// (`pnpm test:integration:pooled`); the harness has then checked that the
// pooler really serves the database.

const HOOK_TIMEOUT_MS = 300_000;
const ROUNDS = 20;
const POOLED = (process.env["SLUGBASE_TEST_POOLER_URL"] ?? "") !== "";

type Row = Record<string, unknown>;
type Query = (statement: string) => Promise<Row[]>;
/** A transaction that carries a tenant context, as `work` sees it. */
type TenantRunner = (context: TenantContext, work: (query: Query) => Promise<void>) => Promise<void>;

const SETTINGS_SQL = `SELECT pg_backend_pid() AS pid,
                              nullif(current_setting('app.account_id', true), '') AS account,
                              nullif(current_setting('app.workspace_id', true), '') AS workspace`;
const LABELS_SQL = "SELECT label FROM tenant_probe ORDER BY label";
const ROLLBACK = new Error("roll this transaction back");

let database: TestDatabase;
const clients: postgres.Sql[] = [];

// A pool of one client connection to the pooler, as the application role, like one process of the server.
function connect(): postgres.Sql {
  const { host, port, pass } = database.app.options;
  const client = postgres({
    host: host[0],
    port: port[0],
    database: database.name,
    username: "slugbase_app",
    password: String(pass),
    max: 1,
    onnotice: () => undefined,
  });
  clients.push(client);
  return client;
}

// The production tenant transaction.
function withTenantRunner(client: postgres.Sql): TenantRunner {
  const { withTenant } = bindTenantDatabase(client);
  return (context, work) =>
    withTenant(context, (tx) => work(async (statement) => Array.from(await tenantHandle(tx).execute<Row>(sql.raw(statement)))));
}

// The defect this file guards against: a tenant transaction that sets the
// context for the session (set_config with is_local false) instead of for the
// transaction. It is test code and appears nowhere in the product.
function sessionWideRunner(client: postgres.Sql): TenantRunner {
  return (context, work) =>
    client.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${context.accountId}, false),
                      set_config('app.workspace_id', ${context.workspaceId ?? ""}, false),
                      set_config('app.request_id', ${context.requestId}, false)`;
      await work(async (statement) => Array.from(await tx.unsafe<Row[]>(statement)));
    });
}

function observed(row: Row | undefined): { pid: number; account: string | null; workspace: string | null } {
  return {
    pid: Number(row?.["pid"]),
    account: typeof row?.["account"] === "string" ? row["account"] : null,
    workspace: typeof row?.["workspace"] === "string" ? row["workspace"] : null,
  };
}

interface Side {
  readonly name: string;
  readonly runner: TenantRunner;
  /** The contexts its transactions rotate through, and the probe rows each may see. */
  readonly contexts: readonly { context: TenantContext; labels: readonly string[] }[];
}

/**
 * Runs the transactions of `sides` at the same time, every side from a client of
 * its own, with a plain client reading between them, and returns what went
 * wrong: a transaction that saw another side's context or rows, a plain
 * transaction that saw any setting or row, and transactions that did not share
 * one backend or never alternated between the sides.
 */
async function interleave(sides: readonly Side[], observer: postgres.Sql): Promise<string[]> {
  const violations: string[] = [];
  const backends = new Set<number>();
  const order: string[] = [];

  const plain = async (when: string): Promise<void> => {
    const seen = await observer.begin(async (tx) => ({
      settings: observed((await tx.unsafe<Row[]>(SETTINGS_SQL))[0]),
      labels: (await tx.unsafe<Row[]>(LABELS_SQL)).map((row) => row["label"]),
    }));
    backends.add(seen.settings.pid);
    if (seen.settings.account !== null || seen.settings.workspace !== null) {
      violations.push(`leaked setting: a transaction with no context saw ${JSON.stringify(seen.settings)} ${when}`);
    }
    if (seen.labels.length > 0) {
      violations.push(`leaked rows: a transaction with no context saw ${JSON.stringify(seen.labels)} ${when}`);
    }
  };

  const loop = async (side: Side): Promise<void> => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const target = side.contexts[round % side.contexts.length];
      if (target === undefined) {
        throw new Error("a side needs a context");
      }
      const context = { ...target.context, requestId: `${side.name}-${String(round)}` };
      try {
        await side.runner(context, async (query) => {
          order.push(side.name);
          const settings = observed((await query(SETTINGS_SQL))[0]);
          // Long enough for the other sides' transactions to be waiting for the backend.
          await query("SELECT pg_sleep(0.005)");
          const labels = (await query(LABELS_SQL)).map((row) => row["label"]);
          backends.add(settings.pid);
          if (settings.account !== context.accountId || settings.workspace !== (context.workspaceId ?? null)) {
            violations.push(`${context.requestId} saw ${JSON.stringify(settings)}, not its own context`);
          }
          if (JSON.stringify(labels) !== JSON.stringify(target.labels)) {
            violations.push(`${context.requestId} saw the rows ${JSON.stringify(labels)}, not ${JSON.stringify(target.labels)}`);
          }
          if (round % 3 === 2) {
            throw ROLLBACK;
          }
        });
      } catch (error) {
        if (error !== ROLLBACK) {
          throw error;
        }
      }
    }
  };

  const reading = (async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      await plain(`between transactions (round ${String(round)})`);
    }
  })();
  await Promise.all([...sides.map(loop), reading]);
  await plain("after the last transaction");

  if (backends.size !== 1) {
    violations.push(`the transactions ran on ${String(backends.size)} backends, so they did not share the pooled connection`);
  }
  const switches = order.filter((name, at) => at > 0 && name !== order[at - 1]).length;
  if (switches < 4) {
    violations.push(`the sides alternated ${String(switches)} times, so their transactions were not interleaved`);
  }
  return violations;
}

const sideA = (runner: TenantRunner): Side => ({
  name: "a",
  runner,
  contexts: [{ context: { accountId: ACCOUNT_A, workspaceId: WORKSPACE_A, requestId: "x" }, labels: ["a"] }],
});

// Workspace B and, in between, an account-level call that names no workspace.
const sideB = (runner: TenantRunner): Side => ({
  name: "b",
  runner,
  contexts: [
    { context: { accountId: ACCOUNT_B, workspaceId: WORKSPACE_B, requestId: "x" }, labels: ["b"] },
    { context: { accountId: ACCOUNT_B, requestId: "x" }, labels: [] },
  ],
});

beforeAll(async () => {
  if (!POOLED) {
    return;
  }
  database = await createTestDatabase();
  await createProbeTables(database);
  await seedProbeRows(database);
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  if (!POOLED) {
    return;
  }
  await Promise.all(clients.map((client) => client.end({ timeout: 5 })));
  await database.drop();
}, HOOK_TIMEOUT_MS);

describe.skipIf(!POOLED)("the tenant context behind PgBouncer in transaction mode", () => {
  it("serves the app pool of the harness through the pooler, on one backend", async () => {
    expect(database.pooler).toEqual({ host: database.app.options.host[0], port: database.app.options.port[0] });
    const pids = await Promise.all(Array.from({ length: 8 }, () => database.app<{ pid: number }[]>`SELECT pg_backend_pid() AS pid, pg_sleep(0.01)`));
    expect(new Set(pids.map((rows) => rows[0]?.pid)).size).toBe(1);
  });

  it("leaves no setting on the shared connection after a commit", async () => {
    const { withTenant } = bindTenantDatabase(connect());
    const observer = connect();
    const inside = await withTenant({ accountId: ACCOUNT_A, workspaceId: WORKSPACE_A, requestId: "commit-1" }, async (tx) => {
      const rows = await tenantHandle(tx).execute<Row>(sql.raw(SETTINGS_SQL));
      return observed(Array.from(rows)[0]);
    });
    expect(inside).toMatchObject({ account: ACCOUNT_A, workspace: WORKSPACE_A });
    const after = await observer.unsafe<Row[]>(SETTINGS_SQL);
    expect(observed(after[0])).toEqual({ pid: inside.pid, account: null, workspace: null });
  });

  it("leaves no setting on the shared connection after a rollback", async () => {
    const { withTenant } = bindTenantDatabase(connect());
    const observer = connect();
    let inside = 0;
    await expect(
      withTenant({ accountId: ACCOUNT_B, workspaceId: WORKSPACE_B, requestId: "rollback-1" }, async (tx) => {
        const rows = await tenantHandle(tx).execute<Row>(sql.raw(SETTINGS_SQL));
        inside = observed(Array.from(rows)[0]).pid;
        throw ROLLBACK;
      }),
    ).rejects.toBe(ROLLBACK);
    const after = await observer.unsafe<Row[]>(SETTINGS_SQL);
    expect(observed(after[0])).toEqual({ pid: inside, account: null, workspace: null });
  });

  it("keeps the workspaces apart when transactions of different workspaces and accounts interleave on the shared connection", async () => {
    const violations = await interleave([sideA(withTenantRunner(connect())), sideB(withTenantRunner(connect()))], connect());
    expect(violations).toEqual([]);
  });

  it("detects a tenant transaction that sets the context for the session", async () => {
    const observer = connect();
    try {
      const violations = await interleave([sideA(sessionWideRunner(connect())), sideB(sessionWideRunner(connect()))], observer);
      expect(violations.some((violation) => violation.startsWith("leaked setting:"))).toBe(true);
      expect(violations.some((violation) => violation.startsWith("leaked rows:"))).toBe(true);
    } finally {
      // The pool is one connection, so this reaches the backend that holds the leaked setting.
      await observer`SELECT set_config('app.account_id', '', false), set_config('app.workspace_id', '', false), set_config('app.request_id', '', false)`;
    }
    expect(observed((await observer.unsafe<Row[]>(SETTINGS_SQL))[0])).toMatchObject({ account: null, workspace: null });
  });
});
