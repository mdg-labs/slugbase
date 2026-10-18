import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { hashSqlFiles } from "../../scripts/migration-sql.ts";
import { checkRules, formatReport, runChecks } from "../../src/check/index.ts";
import { createSystemOperationsRule, systemOperationsRule } from "../../src/check/system-operations.ts";
import type { Finding } from "../../src/check/types.ts";
import { systemOperations } from "../../src/system/registry.ts";
import { createTestDatabase, type TestDatabase } from "../../src/testing.ts";
import { PACKAGE } from "./package-copy.ts";

// The system-operations rule (doc 05 section 3.3) against fixture functions in
// scratch databases cloned from the migration template: one test per rule
// that must fail, each fixture breaking that rule and no other.

const HOOK_TIMEOUT_MS = 180_000;
const ID = "system-operations";
const PIN_MESSAGE = "does not pin SET search_path = pg_catalog, public, pg_temp";

const server = new URL(
  process.env["SLUGBASE_TEST_PG_URL"] ?? "postgres://slugbase:slugbase@127.0.0.1:54329/slugbase_dev",
);

const databases: TestDatabase[] = [];
const superusers: postgres.Sql[] = [];

// A function owned by slugbase_system cannot be created by slugbase_owner, so
// the fixtures connect to the scratch database as the server's own superuser.
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

interface Fixture {
  name?: string;
  owner?: string;
  definer?: boolean;
  searchPath?: string | undefined;
  language?: "sql" | "plpgsql";
  body?: string;
  publicExecute?: boolean;
  appExecute?: boolean;
}

/** A function that follows every rule, unless an option breaks one. */
function fixture(options: Fixture = {}): string {
  const name = options.name ?? "sys_fixture";
  const language = options.language ?? "sql";
  const searchPath = "searchPath" in options ? options.searchPath : "pg_catalog, public, pg_temp";
  const body = options.body ?? (language === "sql" ? "SELECT 1" : "BEGIN RETURN 1; END");
  return [
    `CREATE FUNCTION public.${name}() RETURNS int LANGUAGE ${language}`,
    options.definer === false ? "" : "SECURITY DEFINER",
    searchPath === undefined ? "" : `SET search_path = ${searchPath}`,
    `AS $body$${body}$body$`,
    `;ALTER FUNCTION public.${name}() OWNER TO ${options.owner ?? "slugbase_system"}`,
    `;REVOKE ALL ON FUNCTION public.${name}() FROM PUBLIC`,
    options.publicExecute === true ? `;GRANT EXECUTE ON FUNCTION public.${name}() TO PUBLIC` : "",
    options.appExecute === false ? "" : `;GRANT EXECUTE ON FUNCTION public.${name}() TO slugbase_app`,
  ].join("\n");
}

// The scratch databases are clones of the migrated template, so they hold the
// shipped system operations; the registry under test is theirs plus its own.
async function lint(database: TestDatabase, registry: readonly string[]): Promise<readonly Finding[]> {
  return createSystemOperationsRule([...systemOperations, ...registry]).run({ packageDir: PACKAGE, sql: database.app, hashSqlFiles });
}

async function lintFixture(options: Fixture): Promise<readonly Finding[]> {
  const database = await scratch();
  await superuser(database).unsafe(fixture(options));
  return lint(database, [options.name ?? "sys_fixture"]);
}

function finding(message: string, name = "sys_fixture"): Finding {
  return { rule: ID, object: `function public.${name}()`, message };
}

afterEach(async () => {
  await Promise.all(superusers.splice(0).map((client) => client.end({ timeout: 5 })));
  await Promise.all(databases.splice(0).map((database) => database.drop()));
}, HOOK_TIMEOUT_MS);

describe("the shipped chain", () => {
  it("registers the shipped system operations and passes", async () => {
    expect(systemOperations).toEqual([
      "sys_rate_limit_take",
      "sys_rate_limit_purge",
      "sys_login_lookup",
      "sys_session_create",
      "sys_session_lookup",
      "sys_session_revoke",
      "sys_list_sessions",
      "sys_session_revoke_all",
      "app_member_workspace_ids",
      "sys_account_has_password",
      "sys_retention_purge",
      "sys_create_account",
      "sys_create_workspace",
      "sys_setup_status",
      "sys_setup_token_set",
      "sys_complete_setup",
      "sys_account_password_hash",
      "sys_session_reauth",
      "sys_password_set",
      "sys_session_rotate",
      "sys_mfa_get_secret",
      "sys_mfa_set",
      "sys_mfa_accept_step",
      "sys_backup_codes_replace",
      "sys_backup_code_consume",
      "sys_backup_codes_unused",
      "sys_session_promote",
      "sys_session_mfa_failure",
      "sys_mfa_lock",
      "sys_mfa_disable",
      "sys_account_mfa_enabled",
      "sys_api_token_lookup",
      "sys_oidc_state_create",
      "sys_oidc_state_consume",
      "sys_identity_sign_in",
      "sys_identity_link",
      "sys_identity_link_by_email",
      "sys_identity_unlink",
      "sys_identity_reauth",
      "sys_password_set_initial",
      "sys_credential_token_issue",
      "sys_credential_token_consume",
      "sys_signin_alert_context",
      "sys_email_verify",
      "sys_create_personal_workspace",
      "sys_account_email_verified",
      "sys_password_reset",
      "sys_email_change_request",
      "sys_email_change_clear",
      "sys_email_change_token_issue",
      "sys_email_change_confirm",
      "sys_email_change_cancel",
    ]);
    expect(checkRules).toContain(systemOperationsRule);
    const database = await scratch();
    expect(await systemOperationsRule.run({ packageDir: PACKAGE, sql: database.app, hashSqlFiles })).toEqual([]);
  }, HOOK_TIMEOUT_MS);
});

describe("system-operations", () => {
  it("passes a registered function that follows every rule, in either inspectable language", async () => {
    const database = await scratch();
    const root = superuser(database);
    await root.unsafe(fixture({ name: "sys_sql" }));
    await root.unsafe(fixture({ name: "sys_plpgsql", language: "plpgsql" }));
    expect(await lint(database, ["sys_sql", "sys_plpgsql"])).toEqual([]);
  }, HOOK_TIMEOUT_MS);

  it("fails a SECURITY DEFINER function that is not registered, naming it", async () => {
    const database = await scratch();
    await superuser(database).unsafe(fixture());
    expect(await lint(database, [])).toEqual([
      finding("is SECURITY DEFINER but is not in the system operation registry (packages/db/src/system/registry.ts)"),
    ]);
  }, HOOK_TIMEOUT_MS);

  it("does not ask a function that is not SECURITY DEFINER to be registered", async () => {
    const database = await scratch();
    await superuser(database).unsafe(fixture({ definer: false, owner: "slugbase_owner" }));
    expect(await lint(database, [])).toEqual([]);
  }, HOOK_TIMEOUT_MS);

  it("fails a registry entry that has no function, naming it", async () => {
    const database = await scratch();
    expect(await lint(database, ["sys_missing", "cloud.sys_billing"])).toEqual([
      { rule: ID, object: "function public.sys_missing", message: "is in the system operation registry but no such function exists" },
      { rule: ID, object: "function cloud.sys_billing", message: "is in the system operation registry but no such function exists" },
    ]);
  }, HOOK_TIMEOUT_MS);

  it("fails a registered function that is not SECURITY DEFINER", async () => {
    expect(await lintFixture({ definer: false })).toEqual([finding("is in the system operation registry but is not SECURITY DEFINER")]);
  }, HOOK_TIMEOUT_MS);

  it("fails a registered function with the wrong owner", async () => {
    expect(await lintFixture({ owner: "slugbase_owner" })).toEqual([finding("is owned by slugbase_owner, not slugbase_system")]);
  }, HOOK_TIMEOUT_MS);

  it("fails a registered function with a mutable search_path", async () => {
    expect(await lintFixture({ searchPath: undefined })).toEqual([finding(PIN_MESSAGE)]);
  }, HOOK_TIMEOUT_MS);

  it("fails a registered function with another search_path", async () => {
    expect(await lintFixture({ searchPath: "public, pg_catalog" })).toEqual([finding(PIN_MESSAGE)]);
    expect(await lintFixture({ searchPath: "pg_catalog" })).toEqual([finding(PIN_MESSAGE)]);
    expect(await lintFixture({ searchPath: "pg_catalog, public" })).toEqual([finding(PIN_MESSAGE)]);
    expect(await lintFixture({ searchPath: "pg_temp, pg_catalog, public" })).toEqual([finding(PIN_MESSAGE)]);
  }, HOOK_TIMEOUT_MS);

  it("accepts the pinned search_path however it is quoted or cased", async () => {
    expect(await lintFixture({ searchPath: 'pg_catalog, "public", PG_TEMP' })).toEqual([]);
  }, HOOK_TIMEOUT_MS);

  it.each([
    ["EXECUTE format('SELECT %L', 1)"],
    ["execute 'select 1'"],
  ])("fails a registered plpgsql function with dynamic SQL: %s", async (statement) => {
    const findings = await lintFixture({ language: "plpgsql", body: `BEGIN ${statement}; RETURN 1; END` });
    expect(findings).toEqual([finding("contains EXECUTE: a system operation takes no dynamic SQL")]);
  }, HOOK_TIMEOUT_MS);

  it("fails a registered function whose language the rule cannot inspect", async () => {
    const database = await scratch();
    await superuser(database).unsafe(`CREATE FUNCTION public.sys_fixture(a int, b int) RETURNS int LANGUAGE internal
      SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS 'int4pl';
      ALTER FUNCTION public.sys_fixture(int, int) OWNER TO slugbase_system;
      REVOKE ALL ON FUNCTION public.sys_fixture(int, int) FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION public.sys_fixture(int, int) TO slugbase_app`);
    expect(await lint(database, ["sys_fixture"])).toEqual([
      {
        rule: ID,
        object: "function public.sys_fixture(a integer, b integer)",
        message: "is written in language internal, whose body this rule cannot inspect for dynamic SQL (only sql and plpgsql)",
      },
    ]);
  }, HOOK_TIMEOUT_MS);

  it("fails a registered function that PUBLIC can execute", async () => {
    expect(await lintFixture({ publicExecute: true })).toEqual([finding("has EXECUTE granted to PUBLIC")]);
  }, HOOK_TIMEOUT_MS);

  it("fails a registered function whose EXECUTE was never revoked from PUBLIC", async () => {
    const database = await scratch();
    await superuser(database).unsafe(`CREATE FUNCTION public.sys_fixture() RETURNS int LANGUAGE sql
      SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS 'SELECT 1';
      ALTER FUNCTION public.sys_fixture() OWNER TO slugbase_system`);
    expect(await lint(database, ["sys_fixture"])).toEqual([finding("has EXECUTE granted to PUBLIC")]);
  }, HOOK_TIMEOUT_MS);

  it("fails a registered function that slugbase_app cannot execute", async () => {
    expect(await lintFixture({ appExecute: false })).toEqual([finding("does not grant EXECUTE to slugbase_app")]);
  }, HOOK_TIMEOUT_MS);

  it("checks a function of another schema by its qualified name and every overload", async () => {
    const database = await scratch();
    const root = superuser(database);
    await root.unsafe("CREATE SCHEMA cloud");
    await root.unsafe(`CREATE FUNCTION cloud.sys_billing() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'`);
    await root.unsafe(fixture());
    await root.unsafe(`CREATE FUNCTION public.sys_fixture(a int) RETURNS int LANGUAGE sql SECURITY DEFINER
      SET search_path = pg_catalog, public, pg_temp AS 'SELECT 1';
      ALTER FUNCTION public.sys_fixture(int) OWNER TO slugbase_system;
      GRANT EXECUTE ON FUNCTION public.sys_fixture(int) TO slugbase_app`);
    const findings = await lint(database, ["sys_fixture"]);
    expect(findings.map((each) => `${each.object}: ${each.message}`)).toEqual([
      "function cloud.sys_billing(): is SECURITY DEFINER but is not in the system operation registry (packages/db/src/system/registry.ts)",
      "function public.sys_fixture(a integer): has EXECUTE granted to PUBLIC",
    ]);
  }, HOOK_TIMEOUT_MS);

  // T1 (doc 10): a definer function added "for performance" that returns
  // another workspace's row reads around row-level security, and no rule about
  // tables notices it. With the registry empty, the owner it was created with
  // does not matter: db:check fails it by name.
  it("rejects a definer function that reads across workspaces and was never registered", async () => {
    const database = await scratch();
    await superuser(database).unsafe(`CREATE FUNCTION public.fast_bookmark_by_id(id uuid) RETURNS uuid LANGUAGE sql
      SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS 'SELECT id';
      GRANT EXECUTE ON FUNCTION public.fast_bookmark_by_id(uuid) TO slugbase_app`);
    const results = await runChecks(
      checkRules.filter((rule) => rule.id === ID),
      { packageDir: PACKAGE, sql: database.app, hashSqlFiles },
    );
    expect(results[0]?.findings.map((each) => each.object)).toEqual(["function public.fast_bookmark_by_id(id uuid)"]);
    expect(formatReport(results).passed).toBe(false);
    expect(formatReport(results).lines).toContain(
      "db:check: FAIL  system-operations: function public.fast_bookmark_by_id(id uuid): is SECURITY DEFINER but is not in the system operation registry (packages/db/src/system/registry.ts)",
    );
  }, HOOK_TIMEOUT_MS);

  it("fails a wrongly owned definer function even when its name is registered", async () => {
    const database = await scratch();
    await superuser(database).unsafe(fixture({ name: "fast_lookup", owner: "slugbase_owner" }));
    const findings = await lint(database, ["fast_lookup"]);
    expect(findings).toEqual([finding("is owned by slugbase_owner, not slugbase_system", "fast_lookup")]);
  }, HOOK_TIMEOUT_MS);
});
