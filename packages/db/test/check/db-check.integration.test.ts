import { spawnSync } from "node:child_process";
import postgres from "postgres";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { hashSqlFiles } from "../../scripts/migration-sql.ts";
import { checkRules, formatReport, runChecks } from "../../src/check/index.ts";
import { ownershipRule } from "../../src/check/ownership.ts";
import { rlsRule } from "../../src/check/rls.ts";
import type { CheckRule, Finding } from "../../src/check/types.ts";
import { createTestDatabase, type TestDatabase } from "../../src/testing.ts";
import { PackageCopy, PACKAGE } from "./package-copy.ts";

// The rules of `pnpm db:check` that read the database, each against a fixture
// in a scratch database cloned from the migration template, and the command
// itself against the shipped chain (doc 08 section 3.4).

const HOOK_TIMEOUT_MS = 180_000;
const SCRIPT = new URL("../../scripts/db-check.ts", import.meta.url).pathname;

const server = new URL(
  process.env["SLUGBASE_TEST_PG_URL"] ?? "postgres://slugbase:slugbase@127.0.0.1:54329/slugbase_dev",
);

const databases: TestDatabase[] = [];
const superusers: postgres.Sql[] = [];
const copies: PackageCopy[] = [];

// slugbase_app cannot be handed an object by the owner role, so the
// fixtures that give it one connect to the scratch database as the server's
// own superuser.
function superuser(database: TestDatabase): postgres.Sql {
  const client = postgres({
    host: server.hostname,
    port: Number(server.port === "" ? 5432 : server.port),
    database: database.name,
    username: decodeURIComponent(server.username),
    password: decodeURIComponent(server.password),
    max: 1,
    onnotice: () => undefined,
  });
  superusers.push(client);
  return client;
}

async function scratch(): Promise<TestDatabase> {
  const database = await createTestDatabase();
  databases.push(database);
  return database;
}

async function inspect(database: TestDatabase, rule: CheckRule): Promise<readonly Finding[]> {
  return rule.run({ packageDir: PACKAGE, sql: database.app, hashSqlFiles });
}

function tenantTable(name: string, { enable, force, policy }: { enable: boolean; force: boolean; policy: boolean }): string {
  return [
    `CREATE TABLE public.${name} (id uuid PRIMARY KEY, workspace_id uuid NOT NULL)`,
    enable ? `ALTER TABLE public.${name} ENABLE ROW LEVEL SECURITY` : "",
    force ? `ALTER TABLE public.${name} FORCE ROW LEVEL SECURITY` : "",
    policy ? `CREATE POLICY ${name}_tenant ON public.${name} USING (workspace_id = public.app_workspace_id())` : "",
  ]
    .filter((statement) => statement !== "")
    .join(";\n");
}


afterEach(async () => {
  await Promise.all(superusers.splice(0).map((client) => client.end({ timeout: 5 })));
  await Promise.all(databases.splice(0).map((database) => database.drop()));
}, HOOK_TIMEOUT_MS);

afterAll(() => {
  for (const copy of copies) {
    copy.remove();
  }
});

describe("the shipped chain", () => {
  it("passes every rule that reads the database", async () => {
    const database = await scratch();
    expect(await inspect(database, rlsRule)).toEqual([]);
    expect(await inspect(database, ownershipRule)).toEqual([]);
  }, HOOK_TIMEOUT_MS);

  it("passes pnpm db:check", () => {
    const result = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8", timeout: HOOK_TIMEOUT_MS });
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`${String(checkRules.length)} rule(s) passed`);
    expect(result.status).toBe(0);
  }, HOOK_TIMEOUT_MS);
});

describe("rls-forced", () => {
  it("passes a tenant table with RLS enabled, forced and a policy", async () => {
    const database = await scratch();
    await database.owner.unsafe(tenantTable("ok_things", { enable: true, force: true, policy: true }));
    expect(await inspect(database, rlsRule)).toEqual([]);
  }, HOOK_TIMEOUT_MS);

  it("fails a workspace_id table without ENABLE, naming it", async () => {
    const database = await scratch();
    await database.owner.unsafe(tenantTable("no_enable", { enable: false, force: true, policy: true }));
    const findings = await inspect(database, rlsRule);
    expect(findings).toEqual([
      {
        rule: "rls-forced",
        object: "table public.no_enable",
        message: "has a workspace_id column but ROW LEVEL SECURITY is not enabled",
      },
    ]);
  }, HOOK_TIMEOUT_MS);

  it("fails a workspace_id table without FORCE, naming it", async () => {
    const database = await scratch();
    await database.owner.unsafe(tenantTable("no_force", { enable: true, force: false, policy: true }));
    const findings = await inspect(database, rlsRule);
    expect(findings).toEqual([
      {
        rule: "rls-forced",
        object: "table public.no_force",
        message: "has a workspace_id column but FORCE ROW LEVEL SECURITY is not set",
      },
    ]);
  }, HOOK_TIMEOUT_MS);

  it("fails a workspace_id table without a policy, naming it", async () => {
    const database = await scratch();
    await database.owner.unsafe(tenantTable("no_policy", { enable: true, force: true, policy: false }));
    const findings = await inspect(database, rlsRule);
    expect(findings).toEqual([
      {
        rule: "rls-forced",
        object: "table public.no_policy",
        message: "has a workspace_id column but no row-level security policy",
      },
    ]);
  }, HOOK_TIMEOUT_MS);

  it("catches a tenant table in another schema and a dropped column does not count", async () => {
    const database = await scratch();
    await superuser(database).unsafe(`CREATE SCHEMA cloud;
      CREATE TABLE cloud.usage (id uuid PRIMARY KEY, workspace_id uuid NOT NULL);
      CREATE TABLE public.formerly (id uuid PRIMARY KEY, workspace_id uuid);
      ALTER TABLE public.formerly DROP COLUMN workspace_id`);
    const findings = await inspect(database, rlsRule);
    expect(findings.map((finding) => finding.object)).toEqual(["table cloud.usage", "table cloud.usage", "table cloud.usage"]);
  }, HOOK_TIMEOUT_MS);

  // T1 (doc 10): RLS enabled but not forced is silent. The owner of the table
  // bypasses every policy, the table is not owned by slugbase_app, and nothing
  // else the lint checks looks at it. Only this rule rejects it.
  it("rejects a new tenant table with RLS enabled but not forced, which no other rule notices", async () => {
    const database = await scratch();
    await database.owner.unsafe(tenantTable("bookmarks_new", { enable: true, force: false, policy: true }));
    const results = await runChecks(
      checkRules.filter((rule) => rule.id === "rls-forced" || rule.id === "app-owns-nothing"),
      { packageDir: PACKAGE, sql: database.app, hashSqlFiles },
    );
    expect(results.find((result) => result.rule === "app-owns-nothing")?.findings).toEqual([]);
    const rls = results.find((result) => result.rule === "rls-forced");
    expect(rls?.findings.map((finding) => finding.object)).toEqual(["table public.bookmarks_new"]);
    expect(formatReport(results).passed).toBe(false);
    expect(formatReport(results).lines).toContain(
      "db:check: FAIL  rls-forced: table public.bookmarks_new: has a workspace_id column but FORCE ROW LEVEL SECURITY is not set",
    );
  }, HOOK_TIMEOUT_MS);
});

describe("app-owns-nothing", () => {
  it("fails a table owned by slugbase_app, naming it", async () => {
    const database = await scratch();
    await superuser(database).unsafe("CREATE TABLE public.app_table (id int); ALTER TABLE public.app_table OWNER TO slugbase_app");
    expect(await inspect(database, ownershipRule)).toEqual([
      { rule: "app-owns-nothing", object: "table public.app_table", message: "is owned by slugbase_app" },
    ]);
  }, HOOK_TIMEOUT_MS);

  it("fails a function owned by slugbase_app, naming it", async () => {
    const database = await scratch();
    await superuser(database).unsafe(`CREATE FUNCTION public.app_fn(a int) RETURNS int LANGUAGE sql AS 'SELECT 1';
      ALTER FUNCTION public.app_fn(int) OWNER TO slugbase_app`);
    expect(await inspect(database, ownershipRule)).toEqual([
      { rule: "app-owns-nothing", object: "function public.app_fn(integer)", message: "is owned by slugbase_app" },
    ]);
  }, HOOK_TIMEOUT_MS);

  it("fails a schema owned by slugbase_app, naming it", async () => {
    const database = await scratch();
    await superuser(database).unsafe("CREATE SCHEMA app_schema AUTHORIZATION slugbase_app");
    expect(await inspect(database, ownershipRule)).toEqual([
      { rule: "app-owns-nothing", object: "schema app_schema", message: "is owned by slugbase_app" },
    ]);
  }, HOOK_TIMEOUT_MS);

  it("fails a sequence owned by slugbase_app, naming it", async () => {
    const database = await scratch();
    await superuser(database).unsafe("CREATE SEQUENCE public.app_seq; ALTER SEQUENCE public.app_seq OWNER TO slugbase_app");
    expect(await inspect(database, ownershipRule)).toEqual([
      { rule: "app-owns-nothing", object: "sequence public.app_seq", message: "is owned by slugbase_app" },
    ]);
  }, HOOK_TIMEOUT_MS);

  it("fails an enum type owned by slugbase_app, naming it", async () => {
    const database = await scratch();
    await superuser(database).unsafe("CREATE TYPE public.app_kind AS ENUM ('a'); ALTER TYPE public.app_kind OWNER TO slugbase_app");
    expect(await inspect(database, ownershipRule)).toEqual([
      { rule: "app-owns-nothing", object: "type public.app_kind", message: "is owned by slugbase_app" },
    ]);
  }, HOOK_TIMEOUT_MS);
});

describe("pnpm db:check", () => {
  it("fails with the name of a migration edited after it was recorded", () => {
    const copy = new PackageCopy();
    copies.push(copy);
    const tag = copy.firstMigrationTag();
    copy.write(`${copy.read("migrations", `${tag}.sql`)}\n-- edited\n`, "migrations", `${tag}.sql`);
    const result = spawnSync(process.execPath, [SCRIPT, "--package", copy.dir], {
      encoding: "utf8",
      timeout: HOOK_TIMEOUT_MS,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`db:check: FAIL  migration-checksums: migrations/${tag}.sql: changed after it was recorded`);
    expect(result.stdout).toContain("db:check: ok    rls-forced");
  }, HOOK_TIMEOUT_MS);

  it("fails with the name of a schema change that has no migration", () => {
    const copy = new PackageCopy();
    copies.push(copy);
    copy.schema(`import { pgTable, uuid } from "drizzle-orm/pg-core";
export const things = pgTable("things", { id: uuid().primaryKey() });
`);
    const result = spawnSync(process.execPath, [SCRIPT, "--package", copy.dir], {
      encoding: "utf8",
      timeout: HOOK_TIMEOUT_MS,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('db:check: FAIL  schema-drift: src/schema: has changes no migration holds (CREATE TABLE "things"');
  }, HOOK_TIMEOUT_MS);
});
