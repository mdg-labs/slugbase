import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConnectionRoleError, connectionRole } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";

// What `connectionRole` reports for the connections of a migrated database
// (doc 05 section 3.1, Q56): the application and migrator roles are neither
// superusers nor the owner of the database, a superuser is, and so is a role
// that is made the owner of the database.

const HOOK_TIMEOUT_MS = 300_000;

const server = new URL(
  process.env.SLUGBASE_TEST_PG_URL ?? "postgres://slugbase:slugbase@127.0.0.1:54329/slugbase_dev",
);

const ownerRole = `test_dbowner_${randomBytes(6).toString("hex")}`;
const ownerPassword = randomBytes(12).toString("hex");

let db: TestDatabase;
let admin: postgres.Sql;

function urlFor(username: string, password: string, database = db.name): string {
  const url = new URL("postgres://localhost");
  url.hostname = server.hostname;
  url.port = server.port === "" ? "5432" : server.port;
  url.username = username;
  url.password = password;
  url.pathname = `/${database}`;
  return url.href;
}

beforeAll(async () => {
  db = await createTestDatabase();
  admin = postgres({
    host: server.hostname,
    port: server.port === "" ? 5432 : Number(server.port),
    database: "postgres",
    username: decodeURIComponent(server.username),
    password: decodeURIComponent(server.password),
    max: 1,
    onnotice: () => undefined,
  });
  await admin.unsafe(`CREATE ROLE "${ownerRole}" LOGIN PASSWORD '${ownerPassword}'`);
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await db.drop();
  await admin.unsafe(`DROP ROLE IF EXISTS "${ownerRole}"`);
  await admin.end({ timeout: 5 });
}, HOOK_TIMEOUT_MS);

describe("connectionRole", () => {
  it("reports the application role as neither a superuser nor the owner of the database", async () => {
    const result = await connectionRole({ url: urlFor("slugbase_app", "slugbase_app_dev_only") });
    expect(result).toEqual({ role: "slugbase_app", superuser: false, ownsDatabase: false });
  });

  it("reports the migrator role as neither, since the database belongs to slugbase_owner", async () => {
    const result = await connectionRole({ url: urlFor("slugbase_migrator", "slugbase_migrator_dev_only") });
    expect(result).toEqual({ role: "slugbase_migrator", superuser: false, ownsDatabase: false });
  });

  it("reports a superuser", async () => {
    const result = await connectionRole({
      url: urlFor(decodeURIComponent(server.username), decodeURIComponent(server.password)),
    });
    expect(result.superuser).toBe(true);
  });

  it("reports a role that owns the database, and no longer reports it as the owner once the ownership moves", async () => {
    await admin.unsafe(`ALTER DATABASE "${db.name}" OWNER TO "${ownerRole}"`);
    try {
      const owner = await connectionRole({ url: urlFor(ownerRole, ownerPassword) });
      expect(owner).toEqual({ role: ownerRole, superuser: false, ownsDatabase: true });
    } finally {
      await admin.unsafe(`ALTER DATABASE "${db.name}" OWNER TO slugbase_owner`);
    }
    const after = await connectionRole({ url: urlFor(ownerRole, ownerPassword) });
    expect(after.ownsDatabase).toBe(false);
  });

  it("rejects, naming neither the URL nor the password, when it cannot connect", async () => {
    const password = `wrong-${randomBytes(6).toString("hex")}`;
    const url = urlFor("slugbase_app", password);
    const failure = await connectionRole({ url }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ConnectionRoleError);
    const { message, code } = failure as ConnectionRoleError;
    expect(`${message} ${code ?? ""}`).not.toContain(password);
    expect(message).not.toContain(url);
  });

  it("rejects a URL that is not a PostgreSQL URL without echoing it", async () => {
    const failure = await connectionRole({ url: "mysql://user:hunter2@localhost/db" }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ConnectionRoleError);
    expect((failure as Error).message).not.toContain("hunter2");
  });
});
