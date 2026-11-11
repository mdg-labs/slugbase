import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Provisions throwaway PostgreSQL servers through the init directory, the way
// compose.yml does on the first start of an empty volume, and checks that no
// role password is left in the places a server keeps statement text: the
// statistics views, the files pg_stat_statements writes under the data
// directory, and the server log (doc 05 section 3.1).
//
// It needs Docker, so it is opt-in. CI runs it in the build job, which has the
// runner's Docker daemon and fails the step on a skipped case.
//
//   SLUGBASE_TEST_ROLES_STATISTICS=1 pnpm --filter @slugbase/db exec vitest run --project integration roles-statistics
//
// SLUGBASE_TEST_DOCKER_PREFIX names the containers, and
// SLUGBASE_TEST_POSTGRES_IMAGE chooses the image (default: the one compose.yml pins).

const ENABLED = process.env.SLUGBASE_TEST_ROLES_STATISTICS === "1";

const ROLES_SQL = fileURLToPath(new URL("../provision/roles.sql", import.meta.url));
const COMPOSE_YML = fileURLToPath(new URL("../../../compose.yml", import.meta.url));

const POSTGRES_PORT = 5432;
const DATABASE = "slugbase";
const SUPERUSER = "slugbase";

const HOOK_TIMEOUT_MS = 300_000;
const DOCKER_TIMEOUT_MS = 120_000;
const READY_TIMEOUT_MS = 120_000;

const prefix = process.env.SLUGBASE_TEST_DOCKER_PREFIX ?? "slugbase-test";
const suffix = randomBytes(4).toString("hex");

// Generated per run: nothing password-shaped is kept in the repository.
const superuserPassword = randomBytes(16).toString("hex");
const appPassword = randomBytes(16).toString("hex");
const migratorPassword = randomBytes(16).toString("hex");

function pinnedImage(): string {
  const override = process.env.SLUGBASE_TEST_POSTGRES_IMAGE;
  if (override !== undefined && override !== "") {
    return override;
  }
  const image = /^\s+image:\s*(postgres:\S+)\s*$/m.exec(readFileSync(COMPOSE_YML, "utf8"))?.[1];
  if (image === undefined) {
    throw new Error("compose.yml pins no postgres image");
  }
  return image;
}

interface Server {
  name: string;
  port: string;
}

const servers: string[] = [];
const clients: postgres.Sql[] = [];

function docker(args: string[]): { stdout: string; stderr: string } {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    timeout: DOCKER_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`docker ${args[0] ?? ""} failed: ${result.stderr}`);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

function removeContainers(): void {
  for (const name of servers) {
    spawnSync("docker", ["rm", "--force", "--volumes", name], { timeout: DOCKER_TIMEOUT_MS });
  }
}

function connect(server: Server, username: string, password: string): postgres.Sql {
  const client = postgres({
    host: "127.0.0.1",
    port: Number(server.port),
    database: DATABASE,
    username,
    password,
    max: 1,
    onnotice: () => undefined,
    connect_timeout: 5,
  });
  clients.push(client);
  return client;
}

async function until(ready: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await ready()) {
      return;
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// The temporary server of the image's first-start init listens on its socket
// only, so a TCP connection that answers is the server that runs after the init
// directory has been processed and the temporary server has stopped.
async function start(label: string, serverArgs: string[]): Promise<Server> {
  const name = `${prefix}-roles-statistics-${label}-${suffix}`;
  servers.push(name);
  docker([
    "run", "--detach", "--name", name,
    "--publish", `127.0.0.1::${String(POSTGRES_PORT)}`,
    "--env", `POSTGRES_USER=${SUPERUSER}`,
    "--env", `POSTGRES_PASSWORD=${superuserPassword}`,
    "--env", `POSTGRES_DB=${DATABASE}`,
    "--env", `PROVISION_APP_PASSWORD=${appPassword}`,
    "--env", `PROVISION_MIGRATOR_PASSWORD=${migratorPassword}`,
    "--volume", `${ROLES_SQL}:/docker-entrypoint-initdb.d/10-roles.sql:ro`,
    pinnedImage(),
    "postgres", ...serverArgs,
  ]);
  const port = /:(\d+)$/m.exec(docker(["port", name, `${String(POSTGRES_PORT)}/tcp`]).stdout)?.[1] ?? "";
  expect(port).not.toBe("");
  const server = { name, port };
  await until(
    async () => {
      const probe = connect(server, SUPERUSER, superuserPassword);
      try {
        await probe`SELECT 1`;
        return true;
      } catch {
        return false;
      } finally {
        await probe.end({ timeout: 1 });
      }
    },
    READY_TIMEOUT_MS,
    `${label} server to accept connections`,
  );
  return server;
}

function log(server: Server): string {
  const out = docker(["logs", server.name]);
  return `${out.stdout}\n${out.stderr}`;
}

async function readFileOrNull(sql: postgres.Sql, path: string): Promise<Buffer | null> {
  const rows = await sql.unsafe<{ file: Buffer | null }[]>(
    `SELECT pg_read_binary_file('${path}', true) AS file`,
  );
  const file = rows[0]?.file ?? null;
  return file === null ? null : Buffer.from(file);
}

const passwords = { app: appPassword, migrator: migratorPassword };

function expectNoPassword(where: string, text: string | Buffer): void {
  for (const [role, password] of Object.entries(passwords)) {
    expect(text.includes(password), `the ${role} password is in ${where}`).toBe(false);
  }
}

describe.skipIf(!ENABLED)("role passwords on a server that preloads pg_stat_statements", () => {
  let server: Server;
  let admin: postgres.Sql;

  beforeAll(async () => {
    try {
      server = await start("preload", [
        "-c", "shared_preload_libraries=pg_stat_statements",
        "-c", "log_statement=all",
        "-c", "log_min_duration_statement=0",
      ]);
      admin = connect(server, SUPERUSER, superuserPassword);
      await admin.unsafe("CREATE EXTENSION IF NOT EXISTS pg_stat_statements");
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

  // A utility statement run by the test is recorded verbatim, so the places
  // searched below do keep statement text on this server; the checks that
  // follow them are not vacuous.
  const marker = `marker_${randomBytes(6).toString("hex")}`;

  it("records a utility statement of its own in every place it is searched", async () => {
    await admin.unsafe(`CREATE ROLE ${marker} NOLOGIN`);
    await until(
      async () => {
        const views = await admin.unsafe<{ query: string }[]>("SELECT query FROM pg_stat_statements");
        const tmp = await readFileOrNull(admin, "pg_stat_tmp/pgss_query_texts.stat");
        return (
          views.some((row) => row.query.includes(marker)) &&
          tmp?.includes(marker) === true &&
          log(server).includes(marker)
        );
      },
      30_000,
      "the test's own statement in the statistics, their file and the log",
    );
  });

  it("leaves no role password in pg_stat_statements", async () => {
    const rows = await admin.unsafe<{ query: string }[]>("SELECT query FROM pg_stat_statements");
    expect(rows.length).toBeGreaterThan(0);
    expectNoPassword("pg_stat_statements", rows.map((row) => row.query).join("\n"));
  });

  // The provisioning's plannable statements that carry a password as a constant
  // (the check that both are set, and the SELECTs that format CREATE ROLE) are
  // not kept out by `track_utility = off`: only `pg_stat_statements.track = none`
  // does. A statement is recorded normalised in the normal case, so the
  // passwords are absent from it either way; what this guards is that none of
  // them is recorded at all, because an entry evicted early keeps its text with
  // the constants in it.
  it("records none of the provisioning's password-bearing statements", async () => {
    const rows = await admin.unsafe<{ query: string }[]>(
      "SELECT query FROM pg_stat_statements WHERE query ILIKE '%FROM pg_roles WHERE rolname%' OR query ILIKE '%AS passwords_set%'",
    );
    expect(rows.map((row) => row.query)).toEqual([]);
  });

  // The statistics the init server wrote when it stopped are read back at this
  // server's start, which removes pg_stat/pg_stat_statements.stat and rebuilds
  // the query texts in pg_stat_tmp, so a leak of the first start is found there.
  it("leaves no role password in the files pg_stat_statements keeps", async () => {
    for (const path of ["pg_stat_tmp/pgss_query_texts.stat", "pg_stat/pg_stat_statements.stat"]) {
      const file = await readFileOrNull(admin, path);
      if (file !== null) {
        expectNoPassword(path, file);
      }
    }
  });

  it("leaves no role password in the server log", () => {
    expectNoPassword("the server log", log(server));
  });

  it("created both login roles with the passwords it was given", async () => {
    const app = connect(server, "slugbase_app", appPassword);
    const migrator = connect(server, "slugbase_migrator", migratorPassword);
    expect((await app`SELECT current_user AS name`)[0]?.name).toBe("slugbase_app");
    expect((await migrator`SELECT current_user AS name`)[0]?.name).toBe("slugbase_migrator");
  });
});

describe.skipIf(!ENABLED)("role passwords on a server without the pg_stat_statements preload", () => {
  let server: Server;

  beforeAll(async () => {
    try {
      server = await start("plain", ["-c", "log_statement=all", "-c", "log_min_duration_statement=0"]);
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

  it("provisions the four roles, and both login roles connect with their passwords", async () => {
    const admin = connect(server, SUPERUSER, superuserPassword);
    const roles = await admin<{ rolname: string }[]>`
      SELECT rolname FROM pg_roles WHERE rolname LIKE 'slugbase\_%' ORDER BY rolname`;
    expect(roles.map((row) => row.rolname)).toEqual([
      "slugbase_app",
      "slugbase_migrator",
      "slugbase_owner",
      "slugbase_system",
    ]);
    const app = connect(server, "slugbase_app", appPassword);
    const migrator = connect(server, "slugbase_migrator", migratorPassword);
    expect((await app`SELECT current_user AS name`)[0]?.name).toBe("slugbase_app");
    expect((await migrator`SELECT current_user AS name`)[0]?.name).toBe("slugbase_migrator");
  });

  it("leaves no role password in the server log", () => {
    expectNoPassword("the server log", log(server));
  });
});
