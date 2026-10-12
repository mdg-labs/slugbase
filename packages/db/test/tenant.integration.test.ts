import { sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bindTenantDatabase, tenantHandle, TenantContextError, type TenantTx } from "../src/tenant.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { ACCOUNT_A, ACCOUNT_B, WORKSPACE_A, WORKSPACE_B } from "./support/tenant-fixture.ts";

// withTenant against the development Postgres of compose.dev.yml (doc 05
// section 3.2, doc 01 section 9.2): the settings are transaction-local, and a
// pooled connection never carries them to the next request.

const HOOK_TIMEOUT_MS = 300_000;
const APP_PASSWORD = "slugbase_app_dev_only";

let database: TestDatabase;
let single: postgres.Sql;

beforeAll(async () => {
  database = await createTestDatabase();
  const { host, port } = database.app.options;
  // One connection, so every query below runs on the connection the transaction used.
  single = postgres({
    host: host[0],
    port: port[0],
    database: database.name,
    username: "slugbase_app",
    password: APP_PASSWORD,
    max: 1,
    onnotice: () => undefined,
  });
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await single.end({ timeout: 5 });
  await database.drop();
}, HOOK_TIMEOUT_MS);

type Settings = {
  account: string | null;
  workspace: string | null;
  request: string | null;
  role: string;
};

const SETTINGS_SQL = `SELECT nullif(current_setting('app.account_id', true), '') AS account,
                              nullif(current_setting('app.workspace_id', true), '') AS workspace,
                              nullif(current_setting('app.request_id', true), '') AS request,
                              current_user AS role`;

// The settings as the transaction itself sees them.
async function settingsIn(tx: TenantTx): Promise<Settings | undefined> {
  const result = await tenantHandle(tx).execute<Settings>(sql.raw(SETTINGS_SQL));
  return Array.from(result)[0];
}

// The settings as the next query on the connection sees them.
async function settingsAfter(): Promise<Settings | undefined> {
  const rows = await single.unsafe<Settings[]>(SETTINGS_SQL);
  return rows[0];
}

describe("withTenant", () => {
  it("sets the account, workspace and request in a transaction on the application role", async () => {
    const { withTenant } = bindTenantDatabase(single);
    const seen = await withTenant({ accountId: ACCOUNT_A, workspaceId: WORKSPACE_A, requestId: "req-1" }, async (tx) => {
      return settingsIn(tx);
    });
    expect(seen).toEqual({ account: ACCOUNT_A, workspace: WORKSPACE_A, request: "req-1", role: "slugbase_app" });
  });

  it("sets an empty workspace for an account-level call", async () => {
    const { withTenant } = bindTenantDatabase(single);
    const seen = await withTenant({ accountId: ACCOUNT_A, requestId: "req-2" }, async (tx) => {
      expect(tx.workspaceId).toBeUndefined();
      return settingsIn(tx);
    });
    expect(seen).toMatchObject({ account: ACCOUNT_A, workspace: null, request: "req-2" });
  });

  it("leaves no setting on the connection after a commit", async () => {
    const { withTenant } = bindTenantDatabase(single);
    await withTenant({ accountId: ACCOUNT_A, workspaceId: WORKSPACE_A, requestId: "req-3" }, () => Promise.resolve());
    const after = await settingsAfter();
    expect(after).toEqual({ account: null, workspace: null, request: null, role: "slugbase_app" });
  });

  it("leaves no setting on the connection after a rollback, and rethrows the error", async () => {
    const { withTenant } = bindTenantDatabase(single);
    const boom = new Error("boom");
    await expect(
      withTenant({ accountId: ACCOUNT_A, workspaceId: WORKSPACE_A, requestId: "req-4" }, () => Promise.reject(boom)),
    ).rejects.toBe(boom);
    const after = await settingsAfter();
    expect(after).toEqual({ account: null, workspace: null, request: null, role: "slugbase_app" });
  });

  it("does not let a later transaction see the previous one's workspace", async () => {
    const { withTenant } = bindTenantDatabase(single);
    await withTenant({ accountId: ACCOUNT_A, workspaceId: WORKSPACE_A, requestId: "req-5" }, () => Promise.resolve());
    const seen = await withTenant({ accountId: ACCOUNT_B, requestId: "req-6" }, async (tx) => {
      return settingsIn(tx);
    });
    expect(seen).toMatchObject({ account: ACCOUNT_B, workspace: null });
  });

  it("rolls back what the callback wrote when it throws", async () => {
    await database.owner.unsafe("CREATE TABLE rollback_probe (a integer NOT NULL)");
    await database.owner.unsafe("GRANT SELECT, INSERT ON rollback_probe TO slugbase_app");
    const { withTenant } = bindTenantDatabase(single);
    await expect(
      withTenant({ accountId: ACCOUNT_A, requestId: "req-7" }, async (tx) => {
        await tenantHandle(tx).execute(sql.raw("INSERT INTO rollback_probe VALUES (1)"));
        throw new Error("fail after the write");
      }),
    ).rejects.toThrow("fail after the write");
    const rows = await database.owner<{ n: string }[]>`SELECT count(*) AS n FROM rollback_probe`;
    expect(rows[0]?.n).toBe("0");
  });

  it("joins an open transaction for the same account and workspace", async () => {
    const { withTenant } = bindTenantDatabase(single);
    const same = await withTenant({ accountId: ACCOUNT_A, workspaceId: WORKSPACE_A, requestId: "req-8" }, (outer) =>
      withTenant({ accountId: ACCOUNT_A, workspaceId: WORKSPACE_A, requestId: "req-8" }, (inner) =>
        Promise.resolve(inner === outer),
      ),
    );
    expect(same).toBe(true);
  });

  it("throws for a nested call with a different workspace, an account-level one or a different account", async () => {
    const { withTenant } = bindTenantDatabase(single);
    const outer = { accountId: ACCOUNT_A, workspaceId: WORKSPACE_A, requestId: "req-9" };
    const nested = [
      { ...outer, workspaceId: WORKSPACE_B },
      { accountId: ACCOUNT_A, requestId: "req-9" },
      { ...outer, accountId: ACCOUNT_B },
    ];
    for (const context of nested) {
      await expect(withTenant(outer, () => withTenant(context, () => Promise.resolve()))).rejects.toMatchObject({
        name: "TenantContextError",
        code: "nested_context_mismatch",
      });
    }
  });

  it("refuses the transaction handle after the transaction has finished", async () => {
    const { withTenant } = bindTenantDatabase(single);
    const kept = await withTenant({ accountId: ACCOUNT_A, requestId: "req-10" }, (tx) => Promise.resolve(tx));
    expect(() => tenantHandle(kept)).toThrow(TenantContextError);
    expect(() => tenantHandle({ ...kept })).toThrow(/not a tenant transaction/);
  });

  it("serves concurrent callers on one connection one transaction at a time, each with its own settings", async () => {
    const { withTenant } = bindTenantDatabase(single);
    const run = (workspaceId: string, requestId: string) =>
      withTenant({ accountId: ACCOUNT_A, workspaceId, requestId }, async (tx) => {
        return (await settingsIn(tx))?.workspace;
      });
    const seen = await Promise.all([
      run(WORKSPACE_A, "c-1"),
      run(WORKSPACE_B, "c-2"),
      run(WORKSPACE_A, "c-3"),
      run(WORKSPACE_B, "c-4"),
    ]);
    expect(seen).toEqual([WORKSPACE_A, WORKSPACE_B, WORKSPACE_A, WORKSPACE_B]);
  });
});
