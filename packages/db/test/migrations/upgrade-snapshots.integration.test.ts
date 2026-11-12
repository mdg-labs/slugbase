import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CE_CHAIN, migrate, type MigrationChain } from "../../src/migrate.ts";
import { useCluster, type ClusterUse } from "../../src/testing.ts";
import { RELEASED_DIRECTORY, readBack, readSnapshotRecords, type SnapshotRecord } from "./read-back.ts";

// The upgrade test of doc 08 section 3.4: each released schema's snapshot (`released/<tag>.sql.gz`, a `pg_dump` of the seeded instance at the
// migration level of the release, taken by `pnpm db:snapshot <tag>`) is restored into a database provisioned like a production one, every
// migration after the release's last is applied with `migrate`, and the read-back suite (`read-back.ts`) must find the data as the
// snapshot recorded it. The migrations to apply are the CE chain's own, so a migration added after the release is picked up with no
// change to this file. Releases before 1.0.0 (`v0.1.0`) have no snapshot: they are exempt. The release candidate `v1.0.0-rc.1` has one,
// because the upgrade drill starts from it.
//
// The failure scenarios apply a fixture chain after the restore, the way a later release's migration would run, and show that the
// read-back suite names what each one breaks.

const ROLES_SQL = fileURLToPath(new URL("../../provision/roles.sql", import.meta.url));
const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
const APP_PASSWORD = "slugbase_app_dev_only";
const MIGRATOR_PASSWORD = "slugbase_migrator_dev_only";
const HOOK_TIMEOUT_MS = 300_000;
const TEST_TIMEOUT_MS = 180_000;

const server = new URL(
  process.env.SLUGBASE_TEST_PG_URL ?? "postgres://slugbase:slugbase@127.0.0.1:54329/slugbase_dev",
);

function fixture(name: string): MigrationChain {
  return { name, folder: join(FIXTURES, name), bookkeepingTable: `migrations_${name}` };
}

function connection(database: string): Record<string, string> {
  return {
    PGHOST: server.hostname,
    PGPORT: server.port === "" ? "5432" : server.port,
    PGDATABASE: database,
    PGUSER: decodeURIComponent(server.username),
    PGPASSWORD: decodeURIComponent(server.password),
  };
}

function connect(database: string): postgres.Sql {
  return postgres({
    host: server.hostname,
    port: Number(server.port === "" ? "5432" : server.port),
    database,
    username: decodeURIComponent(server.username),
    password: decodeURIComponent(server.password),
    max: 1,
    onnotice: () => undefined,
  });
}

function migratorUrl(database: string): string {
  return `postgres://slugbase_migrator:${encodeURIComponent(MIGRATOR_PASSWORD)}@${server.hostname}:${server.port === "" ? "5432" : server.port}/${database}`;
}

function psql(database: string, args: string[], input?: Buffer): void {
  const result = spawnSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", ...args], {
    encoding: "utf8",
    input,
    timeout: HOOK_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    env: {
      PATH: process.env.PATH ?? "",
      ...connection(database),
      PROVISION_APP_PASSWORD: APP_PASSWORD,
      PROVISION_MIGRATOR_PASSWORD: MIGRATOR_PASSWORD,
    },
  });
  if (result.error) {
    throw result.error;
  }
  expect(result.stderr).not.toMatch(/ERROR/);
  expect(result.status).toBe(0);
}

const clients: postgres.Sql[] = [];
const databases: string[] = [];
let cluster: ClusterUse | undefined;
let admin: postgres.Sql;

// A database of its own, provisioned with the roles like a production one, holding the schema and the data of the snapshot, as
// the backup and restore guide restores a dump into a new server (docs/self-hosting/backup-restore.md).
async function restore(record: SnapshotRecord): Promise<{ name: string; owner: postgres.Sql }> {
  const name = `test_upgrade_${randomBytes(6).toString("hex")}`;
  await admin.unsafe(`CREATE DATABASE ${name}`);
  databases.push(name);
  psql(name, ["-f", ROLES_SQL]);
  psql(name, ["--single-transaction", "-f", "-"], gunzipSync(readFileSync(join(RELEASED_DIRECTORY, record.file))));
  const owner = connect(name);
  clients.push(owner);
  return { name, owner };
}

const records = readSnapshotRecords();
const latest = records[records.length - 1];

beforeAll(async () => {
  cluster = await useCluster();
  admin = connect(server.pathname.slice(1));
  clients.push(admin);
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  try {
    for (const name of databases) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    }
  } finally {
    for (const client of clients) {
      await client.end({ timeout: 5 });
    }
    await cluster?.release();
  }
}, HOOK_TIMEOUT_MS);

describe("the snapshots of the released schemas", () => {
  it("include the release candidate and 1.0.0, and each of them is tested below", () => {
    expect(records.map((record) => record.tag)).toEqual(expect.arrayContaining(["v1.0.0-rc.1", "v1.0.0"]));
  });

  for (const record of records) {
    describe(record.tag, () => {
      const later = (): string[] => {
        const journal = JSON.parse(readFileSync(join(CE_CHAIN.folder, "meta", "_journal.json"), "utf8")) as {
          entries: { tag: string }[];
        };
        return journal.entries.slice(record.migrationCount).map((entry) => entry.tag);
      };

      it(
        "restores, reads back clean as it was taken, applies every later migration and reads back clean again",
        { timeout: TEST_TIMEOUT_MS },
        async () => {
          const { name, owner } = await restore(record);
          expect(await readBack(owner, record)).toEqual([]);
          const recorded = await owner.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM drizzle.${CE_CHAIN.bookkeepingTable}`);
          expect(recorded[0]?.n).toBe(record.migrationCount);

          const result = await migrate({ url: migratorUrl(name) });
          expect(result.applied.map((migration) => migration.tag)).toEqual(later());

          expect(await readBack(owner, record)).toEqual([]);
          const after = await owner.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM drizzle.${CE_CHAIN.bookkeepingTable}`);
          expect(after[0]?.n).toBe(record.migrationCount + later().length);
        },
      );
    });
  }
});

describe("the read-back suite", () => {
  const scenarios = [
    {
      chain: "upgrade_drops_slug",
      why: "a migration that drops the slug column of the bookmarks",
      violation: "bookmarks.slug no longer exists",
    },
    {
      chain: "upgrade_loses_rows",
      why: "a migration that loses the bookmarks",
      violation: "table bookmarks held",
    },
    {
      chain: "upgrade_weakens_rls",
      why: "a migration that stops forcing row-level security on a tenant table",
      violation: "table bookmarks has a workspace_id column but row-level security is not forced",
    },
  ];

  for (const scenario of scenarios) {
    it(
      `fails for ${scenario.why}`,
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        if (latest === undefined) {
          throw new Error("no snapshot is committed");
        }
        const { name, owner } = await restore(latest);
        expect(await readBack(owner, latest)).toEqual([]);
        await migrate({ url: migratorUrl(name), chains: [fixture(scenario.chain)] });
        const violations = await readBack(owner, latest);
        expect(violations.some((violation) => violation.includes(scenario.violation)), violations.join("\n")).toBe(true);
      },
    );
  }
});
