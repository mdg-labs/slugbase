import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, type MigrationChain } from "../../src/migrate.ts";

// A client host that vanishes sends the server no FIN and no RST, so only the
// keepalives of the migrate session end its concurrent index build (doc 05
// section 5.2). The client runs in a container on a network of its own, which
// is disconnected mid-build. A SIGSTOPped or killed process would not do: its
// kernel still answers the probes or closes the socket.
//
// It needs Docker and about three minutes, so it is opt-in. It starts a
// Postgres container of its own, rather than reusing the development one,
// because attaching a running container to another network resets the
// connections published to the host.
//
//   SLUGBASE_TEST_BLACKHOLE=1 pnpm --filter @slugbase/db exec vitest run --project integration blackhole
//
// SLUGBASE_TEST_DOCKER_PREFIX names the containers and the network, and
// SLUGBASE_TEST_CLIENT_IMAGE and SLUGBASE_TEST_POSTGRES_IMAGE choose their images.

const ENABLED = process.env.SLUGBASE_TEST_BLACKHOLE === "1";

const ROLES_SQL = new URL("../../provision/roles.sql", import.meta.url).pathname;
const FIXTURES = new URL("./fixtures/", import.meta.url).pathname;
const WORKSPACE_ROOT = new URL("../../../../", import.meta.url).pathname.replace(/\/$/, "");

const APP_PASSWORD = "slugbase_app_dev_only";
const MIGRATOR_PASSWORD = "slugbase_migrator_dev_only";
const SUPERUSER_PASSWORD = `su-${randomBytes(6).toString("hex")}`;
const POSTGRES_PORT = 5432;

// idle + interval * count of the migrate session, plus a minute for the server's timers.
const KEEPALIVE_BOUND_MS = (60 + 10 * 6) * 1000 + 60_000;
const HOOK_TIMEOUT_MS = 180_000;

const prefix = process.env.SLUGBASE_TEST_DOCKER_PREFIX ?? "slugbase-test";
const suffix = randomBytes(4).toString("hex");
const network = `${prefix}-blackhole-${suffix}`;
const postgresName = `${prefix}-blackhole-pg-${suffix}`;
const clientName = `${prefix}-blackhole-client-${suffix}`;

const chain: MigrationChain = {
  name: "snapshot",
  folder: join(FIXTURES, "snapshot"),
  bookkeepingTable: "migrations_snapshot",
};

let hostPort = "";
let admin: postgres.Sql | undefined;
let database = "";
const clients: postgres.Sql[] = [];

function docker(args: string[]): string {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`docker ${args[0] ?? ""} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function connectAs(username: string, password: string, name: string): postgres.Sql {
  const client = postgres({
    host: "127.0.0.1",
    port: Number(hostPort),
    database: name,
    username,
    password,
    max: 1,
    onnotice: () => undefined,
  });
  clients.push(client);
  return client;
}

function migratorUrl(host: string, port: string): string {
  return `postgres://slugbase_migrator:${encodeURIComponent(MIGRATOR_PASSWORD)}@${host}:${port}/${database}`;
}

async function recordedRows(owner: postgres.Sql): Promise<number> {
  const rows = await owner.unsafe<{ n: number }[]>("SELECT count(*)::int AS n FROM drizzle.migrations_snapshot");
  return rows[0]?.n ?? -1;
}

async function indexes(owner: postgres.Sql): Promise<{ name: string; valid: boolean }[]> {
  return owner<{ name: string; valid: boolean }[]>`
    SELECT c.relname AS name, i.indisvalid AS valid
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname = 'snapshot_target_a_idx'`;
}

// A transaction that has run a query holds a snapshot, and a concurrent index
// build waits for it. Returns the call that ends the transaction.
async function holdSnapshot(owner: postgres.Sql): Promise<() => Promise<void>> {
  let held!: () => void;
  let release!: () => void;
  const isHeld = new Promise<void>((resolve) => (held = resolve));
  const mayRelease = new Promise<void>((resolve) => (release = resolve));
  const holding = owner.begin("isolation level repeatable read", async (tx) => {
    await tx.unsafe("SELECT count(*) FROM pg_class");
    held();
    await mayRelease;
  });
  await Promise.race([isHeld, holding]);
  return async () => {
    release();
    await holding;
  };
}

async function waitFor(ready: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await ready()) {
      return;
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function removeContainers(): void {
  spawnSync("docker", ["rm", "--force", "--volumes", clientName, postgresName]);
  spawnSync("docker", ["network", "rm", network]);
}

describe.skipIf(!ENABLED)("a migrate client whose host vanished mid-build (doc 05 section 5.2)", () => {
  beforeAll(async () => {
    try {
      docker(["network", "create", network]);
      docker([
        "run", "--detach", "--name", postgresName, "--network", network, "--network-alias", postgresName,
        "--publish", `127.0.0.1::${String(POSTGRES_PORT)}`,
        "--env", `POSTGRES_PASSWORD=${SUPERUSER_PASSWORD}`,
        process.env.SLUGBASE_TEST_POSTGRES_IMAGE ?? "postgres:18",
      ]);
      hostPort = /:(\d+)$/m.exec(docker(["port", postgresName, `${String(POSTGRES_PORT)}/tcp`]))?.[1] ?? "";
      expect(hostPort).not.toBe("");
      await waitFor(
        async () => {
          const probe = connectAs("postgres", SUPERUSER_PASSWORD, "postgres");
          try {
            await probe`SELECT 1`;
            return true;
          } catch {
            return false;
          } finally {
            await probe.end({ timeout: 1 });
          }
        },
        60_000,
        "the Postgres container",
      );
      admin = connectAs("postgres", SUPERUSER_PASSWORD, "postgres");
      database = `test_blackhole_${randomBytes(6).toString("hex")}`;
      await admin.unsafe(`CREATE DATABASE ${database}`);
      const result = spawnSync("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-f", ROLES_SQL], {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "",
          PGHOST: "127.0.0.1",
          PGPORT: hostPort,
          PGDATABASE: database,
          PGUSER: "postgres",
          PGPASSWORD: SUPERUSER_PASSWORD,
          PROVISION_APP_PASSWORD: APP_PASSWORD,
          PROVISION_MIGRATOR_PASSWORD: MIGRATOR_PASSWORD,
        },
      });
      if (result.error) {
        throw result.error;
      }
      expect(result.stderr).not.toMatch(/ERROR/);
      expect(result.status).toBe(0);
    } catch (error) {
      removeContainers();
      throw error;
    }
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    try {
      await Promise.all(clients.map((client) => client.end({ timeout: 1 })));
    } finally {
      removeContainers();
    }
  }, HOOK_TIMEOUT_MS);

  it("has its build cancelled within the keepalive bound, so the next run rebuilds the index", async () => {
    const server = admin;
    if (server === undefined) {
      throw new Error("the test Postgres is not running");
    }
    const owner = connectAs("postgres", SUPERUSER_PASSWORD, database);
    const release = await holdSnapshot(connectAs("postgres", SUPERUSER_PASSWORD, database));
    let released = false;
    try {
      docker([
        "run", "--detach", "--name", clientName, "--network", network,
        "--mount", `type=bind,source=${WORKSPACE_ROOT},target=${WORKSPACE_ROOT},readonly`,
        "--env", `MIGRATE_URL=${migratorUrl(postgresName, String(POSTGRES_PORT))}`,
        "--env", `MIGRATE_FOLDER=${chain.folder}`,
        process.env.SLUGBASE_TEST_CLIENT_IMAGE ?? "node:24-slim",
        "node", "--input-type=module", "-e",
        `import { migrate } from ${JSON.stringify(new URL("../../src/migrate.ts", import.meta.url).href)};
await migrate({
  url: process.env.MIGRATE_URL,
  chains: [{ name: "snapshot", folder: process.env.MIGRATE_FOLDER, bookkeepingTable: "migrations_snapshot" }],
});`,
      ]);
      let backend = 0;
      await waitFor(
        async () => {
          const rows = await server<{ pid: number }[]>`
            SELECT pid FROM pg_stat_activity
            WHERE datname = ${database} AND wait_event_type = 'Lock' AND query ILIKE '%INDEX CONCURRENTLY%'
              AND pid <> pg_backend_pid()`;
          backend = rows[0]?.pid ?? 0;
          return backend !== 0;
        },
        60_000,
        "the concurrent index build to wait for the older snapshot",
      );

      docker(["network", "disconnect", network, clientName]);
      // The older snapshot is still held: only the keepalives can end the build now.
      await waitFor(
        async () => {
          const rows = await server<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = ${backend}`;
          return rows[0]?.n === 0;
        },
        KEEPALIVE_BOUND_MS,
        "the server to notice the vanished client",
      );
      await release();
      released = true;
    } finally {
      spawnSync("docker", ["rm", "--force", clientName]);
      if (!released) {
        await release();
      }
    }

    expect((await indexes(owner)).filter((index) => index.valid)).toEqual([]);
    expect(await recordedRows(owner)).toBe(1);

    const result = await migrate({ url: migratorUrl("127.0.0.1", hostPort), chains: [chain] });

    expect(result.applied).toHaveLength(1);
    expect(await indexes(owner)).toEqual([{ name: "snapshot_target_a_idx", valid: true }]);
    expect(await recordedRows(owner)).toBe(2);
  }, 300_000);
});
