import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { connect, createServer } from "node:net";
import { resolve } from "node:path";
import { createTestDatabase, type TestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The worker command needs a database: it starts pg-boss against it. The
// tests run the entry point as a process, the way the image does.

const APP = resolve(import.meta.dirname, "..");

const valid = {
  NODE_ENV: "production",
  APP_ORIGIN: "https://bookmarks.example.com",
  DATABASE_URL: "postgres://slugbase_app:Zq8-prod-app-pw@db.internal:5432/slugbase",
  DATABASE_MIGRATE_URL: "postgres://slugbase_migrator:Zq8-prod-mig-pw@db.internal:5432/slugbase",
  SESSION_SECRET: randomBytes(48).toString("base64url"),
  ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  ENCRYPTION_KEY_ID: "k1",
};

function databaseUrl(database: TestDatabase, pool: "app" | "owner" = "app"): string {
  const { options } = database[pool];
  const url = new URL("postgres://localhost");
  url.hostname = String(options.host[0]);
  url.port = String(options.port[0]);
  url.username = options.user;
  url.password = String(options.pass);
  url.pathname = `/${options.database}`;
  return url.href;
}

const SERVER = new URL(process.env["SLUGBASE_TEST_PG_URL"] ?? "postgres://slugbase:slugbase@127.0.0.1:54329/slugbase_dev");
const SUPERUSER = { username: decodeURIComponent(SERVER.username), password: decodeURIComponent(SERVER.password) };

// The migrate command, as a process, against the database.
function runMigrate(database: TestDatabase, env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, ["src/main.ts", "migrate"], {
    cwd: APP,
    env: {
      PATH: process.env["PATH"] ?? "",
      ...valid,
      NODE_ENV: "test",
      DATABASE_URL: databaseUrl(database),
      DATABASE_MIGRATE_URL: databaseUrl(database, "owner"),
      ...env,
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

interface WorkerRun {
  status: number | null;
  output: string;
  instances: number;
  /** What `whenStarted` returned. */
  observed?: string;
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => {
        resolvePort(typeof address === "object" && address !== null ? address.port : 0);
      });
    });
  });
}

function get(port: number, path: string): Promise<string> {
  return send(port, `GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
}

// A same-origin JSON POST, as the SPA sends one.
function post(port: number, path: string, body: unknown): Promise<string> {
  const text = JSON.stringify(body);
  return send(
    port,
    `POST ${path} HTTP/1.1\r\nHost: localhost\r\nOrigin: ${valid.APP_ORIGIN}\r\nContent-Type: application/json\r\nContent-Length: ${String(Buffer.byteLength(text))}\r\nConnection: close\r\n\r\n${text}`,
  );
}

function send(port: number, request: string): Promise<string> {
  return new Promise((resolveBody) => {
    const chunks: Buffer[] = [];
    const socket = connect({ port, host: "127.0.0.1" });
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("close", () => {
      resolveBody(Buffer.concat(chunks).toString("utf8"));
    });
    socket.on("error", () => undefined);
    socket.write(request);
  });
}

// Starts the worker command, waits until it reports that it started, counts the
// pg-boss instances registered in the database, sends SIGTERM and waits for the exit.
async function runWorker(
  database: TestDatabase,
  options: { env?: Record<string, string>; whenStarted?: () => Promise<string> } = {},
): Promise<WorkerRun> {
  const child = spawn(process.execPath, ["src/main.ts", "worker"], {
    cwd: APP,
    env: { PATH: process.env["PATH"] ?? "", ...valid, NODE_ENV: "test", DATABASE_URL: databaseUrl(database), ...options.env },
  });
  let output = "";
  const exited = new Promise<number | null>((resolveExit) => {
    child.on("close", (code) => {
      resolveExit(code);
    });
  });
  const started = new Promise<boolean>((resolveStarted) => {
    const watch = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
      if (output.includes('"Worker started"')) {
        resolveStarted(true);
      }
    };
    child.stdout.on("data", watch);
    child.stderr.on("data", watch);
    void exited.then(() => {
      resolveStarted(false);
    });
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  try {
    let instances = 0;
    let observed: string | undefined;
    if (await started) {
      observed = await options.whenStarted?.();
      const rows = await database.app<{ count: string }[]>`SELECT count(*) FROM pgboss.instance`;
      instances = Number(rows[0]?.count);
    }
    child.kill("SIGTERM");
    return { status: await exited, output, instances, ...(observed === undefined ? {} : { observed }) };
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");
  }
}

describe("apps/slugbase main worker", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  }, 300_000);

  afterAll(async () => {
    await database.drop();
  }, 300_000);

  it("fails to start, naming no secret, and without a worker while the pg-boss schema is not installed", async () => {
    const { status, output, instances } = await runWorker(database);
    expect(status).toBe(1);
    expect(instances).toBe(0);
    expect(output).not.toContain('"Worker started"');
    expect(output).toContain("pg-boss is not installed");
    expect(output).not.toContain("slugbase_app_dev_only");
  }, 60_000);

  it("starts pg-boss as slugbase_app once `migrate` installed it, registers itself and exits 0 on SIGTERM", async () => {
    const migrated = runMigrate(database);
    expect(migrated.status, migrated.output).toBe(0);

    const { status, output, instances } = await runWorker(database);
    expect(status, output).toBe(0);
    expect(output).toContain("Worker started");
    expect(output).toContain("Shutdown complete");
    expect(instances).toBeGreaterThan(0);
  }, 60_000);

  // The superuser of the test cluster stands for the owner of the tables: row-level security does not apply to it.
  function superuserUrl(): string {
    const url = new URL(databaseUrl(database));
    url.username = SUPERUSER.username;
    url.password = SUPERUSER.password;
    return url.href;
  }

  it("refuses to start in production as a role that row-level security does not hold, naming no connection string (Q56)", async () => {
    const migrated = runMigrate(database);
    expect(migrated.status, migrated.output).toBe(0);

    const { status, output, instances } = await runWorker(database, { env: { NODE_ENV: "production", DATABASE_URL: superuserUrl() } });
    expect(status).toBe(1);
    expect(instances).toBe(0);
    expect(output).not.toContain('"Worker started"');
    expect(output).toContain("is a superuser");
    expect(output).toContain("slugbase_migrator");
    expect(output).toContain("SLUGBASE_ALLOW_OWNER_CONNECTION");
    expect(output).not.toMatch(/postgresql?:\/\/[^\s"]*@/);
  }, 60_000);

  it("starts in production as that role with SLUGBASE_ALLOW_OWNER_CONNECTION=true, and warns", async () => {
    const { status, output, instances } = await runWorker(database, {
      env: { NODE_ENV: "production", DATABASE_URL: superuserUrl(), SLUGBASE_ALLOW_OWNER_CONNECTION: "true" },
    });
    expect(status, output).toBe(0);
    expect(output).toContain("Worker started");
    expect(output).toContain('"level":"warn"');
    expect(output).toContain("SLUGBASE_ALLOW_OWNER_CONNECTION is set");
    expect(output).not.toMatch(/postgresql?:\/\/[^\s"]*@/);
    expect(instances).toBeGreaterThan(0);
  }, 60_000);

  it("serves /metrics on the internal port while the worker runs and stops with it", async () => {
    const metricsPort = await freePort();
    const { status, output, observed } = await runWorker(database, {
      env: { METRICS_PORT: String(metricsPort) },
      whenStarted: () => get(metricsPort, "/metrics"),
    });
    expect(status, output).toBe(0);
    expect(observed).toMatch(/^HTTP\/1\.1 200 /);
    expect(observed).toContain("# TYPE slugbase_db_tenant_transactions_in_flight gauge");
    expect(output).toContain("Metrics listening");
  }, 60_000);
});

interface ServerRun {
  status: number | null;
  output: string;
  /** The answer to GET /ready, when the server got as far as listening. */
  ready: string;
  /** What `whenReady` returned. */
  observed?: string;
}

// Starts the server command and waits until it listens or exits. A listening
// server is asked for /ready, sent SIGTERM and waited for.
async function runServer(env: Record<string, string>, whenReady?: (port: number) => Promise<string>): Promise<ServerRun> {
  const port = await freePort();
  const child = spawn(process.execPath, ["src/main.ts", "server"], {
    cwd: APP,
    env: { PATH: process.env["PATH"] ?? "", ...valid, PORT: String(port), ...env },
  });
  let output = "";
  const exited = new Promise<number | null>((resolveExit) => {
    child.on("close", (code) => {
      resolveExit(code);
    });
  });
  const listening = new Promise<boolean>((resolveListening) => {
    const watch = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
      if (output.includes('"Listening"')) {
        resolveListening(true);
      }
    };
    child.stdout.on("data", watch);
    child.stderr.on("data", watch);
    void exited.then(() => {
      resolveListening(false);
    });
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  try {
    let ready = "";
    let observed: string | undefined;
    if (await listening) {
      // Listening comes first, and the server answers /ready 503 until its migration is done.
      for (const deadline = Date.now() + 20_000; Date.now() < deadline; ) {
        ready = await get(port, "/ready");
        if (ready.startsWith("HTTP/1.1 200 ")) {
          break;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 200));
      }
      if (ready.startsWith("HTTP/1.1 200 ")) {
        observed = await whenReady?.(port);
      }
    }
    child.kill("SIGTERM");
    return { status: await exited, output, ready, ...(observed === undefined ? {} : { observed }) };
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");
  }
}

describe("apps/slugbase main migrate", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  }, 300_000);

  afterAll(async () => {
    await database.drop();
  }, 300_000);

  it("applies the chain, installs the pg-boss schema and exits 0, and exits 0 again with nothing to do", async () => {
    const first = runMigrate(database);
    expect(first.status, first.output).toBe(0);
    expect(first.output).toContain("The database is migrated");
    const installed = await database.app<{ version: string }[]>`SELECT version FROM pgboss.version`;
    expect(installed).toHaveLength(1);

    const second = runMigrate(database);
    expect(second.status, second.output).toBe(0);
    expect(second.output).toContain("The database is up to date");
  }, 60_000);

  it("exits non-zero with a message that holds no connection string when the migrator cannot log in", () => {
    const url = new URL(databaseUrl(database, "owner"));
    url.password = "wrong-qx80";
    const { status, output } = runMigrate(database, { DATABASE_MIGRATE_URL: url.href });
    expect(status).toBe(1);
    expect(output).toContain('"level":"error"');
    expect(output).not.toContain("wrong-qx80");
    expect(output).not.toContain(url.href);
  }, 60_000);
});

describe("apps/slugbase main server with MIGRATE_ON_START", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  }, 300_000);

  afterAll(async () => {
    await database.drop();
  }, 300_000);

  it("migrates before it serves, installs the pg-boss schema, becomes ready and exits 0 on SIGTERM", async () => {
    const before = await database.owner<{ present: boolean }[]>`SELECT to_regclass('pgboss.version') IS NOT NULL AS present`;
    expect(before[0]?.present).toBe(false);

    const { status, output, ready } = await runServer({
      NODE_ENV: "test",
      DATABASE_URL: databaseUrl(database),
      DATABASE_MIGRATE_URL: databaseUrl(database, "owner"),
    });
    expect(status, output).toBe(0);
    expect(ready).toMatch(/^HTTP\/1\.1 200 /);
    expect(output).toContain("The database is migrated");
    const after = await database.owner<{ present: boolean }[]>`SELECT to_regclass('pgboss.version') IS NOT NULL AS present`;
    expect(after[0]?.present).toBe(true);
  }, 60_000);

  it("never migrates with MIGRATE_ON_START=false, so the pg-boss schema stays uninstalled", async () => {
    const other = await createTestDatabase();
    try {
      const { status, output } = await runServer({
        NODE_ENV: "test",
        DATABASE_URL: databaseUrl(other),
        MIGRATE_ON_START: "false",
        DATABASE_MIGRATE_URL: "",
      });
      expect(status, output).toBe(0);
      expect(output).not.toContain("Migrating the database");
      const present = await other.owner<{ present: boolean }[]>`SELECT to_regclass('pgboss.version') IS NOT NULL AS present`;
      expect(present[0]?.present).toBe(false);
    } finally {
      await other.drop();
    }
  }, 60_000);
});

describe("apps/slugbase main server and public registration", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  }, 300_000);

  afterAll(async () => {
    await database.drop();
  }, 300_000);

  const env = (extra: Record<string, string> = {}): Record<string, string> => ({
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl(database),
    DATABASE_MIGRATE_URL: databaseUrl(database, "owner"),
    ...extra,
  });
  const body = { displayName: "Ada", email: "ada@example.test", password: "a long enough password for ada" };

  async function accountCount(): Promise<number> {
    const rows = await database.owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      return tx<{ count: string }[]>`SELECT count(*) FROM accounts`;
    });
    return Number(rows[0]?.count);
  }

  it("composes the CE defaults: registration is closed and the operation answers 403 registration_closed when the keys are unset", async () => {
    const { status, output, observed } = await runServer(env(), async (port) => `${await get(port, "/api/config")}\n${await post(port, "/api/v1/auth/register", body)}`);
    expect(status, output).toBe(0);
    expect(observed).toContain('"registration":false');
    expect(observed).toMatch(/HTTP\/1\.1 403 /);
    expect(observed).toContain('"code":"registration_closed"');
    expect(await accountCount()).toBe(0);
  }, 60_000);

  it("opens the operation with PUBLIC_REGISTRATION=true: /api/config reports it and POST /auth/register creates an unverified account", async () => {
    const { status, output, observed } = await runServer(
      env({ PUBLIC_REGISTRATION: "true" }),
      async (port) => `${await get(port, "/api/config")}\n${await post(port, "/api/v1/auth/register", body)}`,
    );
    expect(status, output).toBe(0);
    expect(observed).toContain('"registration":true');
    expect(observed).toMatch(/HTTP\/1\.1 202 /);
    const rows = await database.owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      return tx<{ email: string; verified: boolean }[]>`SELECT email, email_verified_at IS NOT NULL AS verified FROM accounts`;
    });
    expect([...rows]).toEqual([{ email: "ada@example.test", verified: false }]);
  }, 60_000);

  it("keeps an unset EMAIL_VERIFICATION_REQUIRED off in the CE: registration works without a mail adapter", async () => {
    const { observed } = await runServer(
      env({ PUBLIC_REGISTRATION: "true" }),
      async (port) => post(port, "/api/v1/auth/register", { ...body, email: "grace@example.test" }),
    );
    expect(observed).toMatch(/HTTP\/1\.1 202 /);
  }, 60_000);

  it("answers 503 mail_unavailable when EMAIL_VERIFICATION_REQUIRED=true and no mail is configured, and creates nothing more", async () => {
    const before = await accountCount();
    const { observed } = await runServer(
      env({ PUBLIC_REGISTRATION: "true", EMAIL_VERIFICATION_REQUIRED: "true" }),
      async (port) => `${await get(port, "/api/config")}\n${await post(port, "/api/v1/auth/register", { ...body, email: "hopper@example.test" })}`,
    );
    expect(observed).toContain('"registration":false');
    expect(observed).toMatch(/HTTP\/1\.1 503 /);
    expect(observed).toContain('"code":"mail_unavailable"');
    expect(await accountCount()).toBe(before);
  }, 60_000);
});

describe("apps/slugbase main server and the instance admin operations", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  }, 300_000);

  afterAll(async () => {
    await database.drop();
  }, 300_000);

  const env = (): Record<string, string> => ({
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl(database),
    DATABASE_MIGRATE_URL: databaseUrl(database, "owner"),
    SETUP_ENABLED: "true",
    SETUP_TOKEN_REQUIRED: "false",
  });
  const first = { displayName: "Ada", email: "ada@example.test", password: "a long enough password for ada", workspaceName: "Home" };
  const STATUS = "/api/v1/instance/status";

  it("composes GET /api/v1/instance/status: it asks for a credential, and refuses the first admin, whom setup signs in without a second factor", async () => {
    const { status, output, observed } = await runServer(env(), async (port) => {
      const anonymous = await get(port, STATUS);
      const created = await post(port, "/api/v1/setup", first);
      const cookie = /set-cookie: (__Host-slugbase_session=[A-Za-z0-9_-]+)/i.exec(created)?.[1] ?? "";
      const signedIn = await send(port, `GET ${STATUS} HTTP/1.1\r\nHost: localhost\r\nCookie: ${cookie}\r\nConnection: close\r\n\r\n`);
      return `${anonymous}\n=====\n${created.split("\r\n")[0] ?? ""}\n=====\n${signedIn}`;
    });
    expect(status, output).toBe(0);
    const [anonymous = "", created = "", signedIn = ""] = (observed ?? "").split("\n=====\n");
    expect(anonymous).toMatch(/^HTTP\/1\.1 401 /);
    expect(anonymous).toContain('"code":"unauthenticated"');
    expect(created).toMatch(/^HTTP\/1\.1 201 /);
    expect(signedIn).toMatch(/^HTTP\/1\.1 403 /);
    expect(signedIn).toContain('"code":"forbidden"');
  }, 60_000);
});

describe("apps/slugbase main server and the instance admin workspace operations", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  }, 300_000);

  afterAll(async () => {
    await database.drop();
  }, 300_000);

  const env = (): Record<string, string> => ({
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl(database),
    DATABASE_MIGRATE_URL: databaseUrl(database, "owner"),
    SETUP_ENABLED: "true",
    SETUP_TOKEN_REQUIRED: "false",
  });
  const first = { displayName: "Ada", email: "ada@example.test", password: "a long enough password for ada", workspaceName: "Home" };

  it("composes GET, POST and DELETE /api/v1/instance/workspaces: each asks for a credential, and each refuses the first admin, whom setup signs in without a second factor", async () => {
    const WORKSPACES = "/api/v1/instance/workspaces";
    const unknown = "0192f3a0-aaaa-7000-8000-00000000dead";
    const { status, output, observed } = await runServer(env(), async (port) => {
      const as = (cookie: string, method: string, path: string, body?: unknown): Promise<string> => {
        const text = body === undefined ? "" : JSON.stringify(body);
        const cookieHeader = cookie === "" ? "" : `Cookie: ${cookie}\r\n`;
        return send(
          port,
          `${method} ${path} HTTP/1.1\r\nHost: localhost\r\nOrigin: ${valid.APP_ORIGIN}\r\n${cookieHeader}Content-Type: application/json\r\nContent-Length: ${String(Buffer.byteLength(text))}\r\nConnection: close\r\n\r\n${text}`,
        );
      };
      const request = { name: "Walker", ownerEmail: "owner@example.test" };
      const anonymous = [await as("", "GET", WORKSPACES), await as("", "POST", WORKSPACES, request), await as("", "DELETE", `${WORKSPACES}/${unknown}`)];
      const created = await post(port, "/api/v1/setup", first);
      const cookie = /set-cookie: (__Host-slugbase_session=[A-Za-z0-9_-]+)/i.exec(created)?.[1] ?? "";
      const signedIn = [await as(cookie, "GET", WORKSPACES), await as(cookie, "POST", WORKSPACES, request), await as(cookie, "DELETE", `${WORKSPACES}/${unknown}`)];
      return [...anonymous, ...signedIn].map((answer) => `${answer.split("\r\n")[0] ?? ""} ${/"code":"([a-z_]+)"/.exec(answer)?.[1] ?? ""}`).join("\n=====\n");
    });
    expect(status, output).toBe(0);
    expect((observed ?? "").split("\n=====\n")).toEqual([
      "HTTP/1.1 401 Unauthorized unauthenticated",
      "HTTP/1.1 401 Unauthorized unauthenticated",
      "HTTP/1.1 401 Unauthorized unauthenticated",
      "HTTP/1.1 403 Forbidden forbidden",
      "HTTP/1.1 403 Forbidden forbidden",
      "HTTP/1.1 403 Forbidden forbidden",
    ]);
  }, 60_000);
});

describe("apps/slugbase main server and the instance admin account operations", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  }, 300_000);

  afterAll(async () => {
    await database.drop();
  }, 300_000);

  const env = (): Record<string, string> => ({
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl(database),
    DATABASE_MIGRATE_URL: databaseUrl(database, "owner"),
    SETUP_ENABLED: "true",
    SETUP_TOKEN_REQUIRED: "false",
  });
  const first = { displayName: "Ada", email: "ada@example.test", password: "a long enough password for ada", workspaceName: "Home" };

  it("composes GET /api/v1/instance/accounts and PATCH /api/v1/instance/accounts/{id}: each asks for a credential, and each refuses the first admin, whom setup signs in without a second factor", async () => {
    const ACCOUNTS = "/api/v1/instance/accounts";
    const unknown = "0192f3a0-aaaa-7000-8000-00000000dead";
    const { status, output, observed } = await runServer(env(), async (port) => {
      const as = (cookie: string, method: string, path: string, body?: unknown): Promise<string> => {
        const text = body === undefined ? "" : JSON.stringify(body);
        const cookieHeader = cookie === "" ? "" : `Cookie: ${cookie}\r\n`;
        return send(
          port,
          `${method} ${path} HTTP/1.1\r\nHost: localhost\r\nOrigin: ${valid.APP_ORIGIN}\r\n${cookieHeader}Content-Type: application/json\r\nContent-Length: ${String(Buffer.byteLength(text))}\r\nConnection: close\r\n\r\n${text}`,
        );
      };
      const change = { disabled: true };
      const anonymous = [await as("", "GET", ACCOUNTS), await as("", "PATCH", `${ACCOUNTS}/${unknown}`, change)];
      const created = await post(port, "/api/v1/setup", first);
      const cookie = /set-cookie: (__Host-slugbase_session=[A-Za-z0-9_-]+)/i.exec(created)?.[1] ?? "";
      const signedIn = [await as(cookie, "GET", ACCOUNTS), await as(cookie, "PATCH", `${ACCOUNTS}/${unknown}`, change)];
      return [...anonymous, ...signedIn].map((answer) => `${answer.split("\r\n")[0] ?? ""} ${/"code":"([a-z_]+)"/.exec(answer)?.[1] ?? ""}`).join("\n=====\n");
    });
    expect(status, output).toBe(0);
    expect((observed ?? "").split("\n=====\n")).toEqual([
      "HTTP/1.1 401 Unauthorized unauthenticated",
      "HTTP/1.1 401 Unauthorized unauthenticated",
      "HTTP/1.1 403 Forbidden forbidden",
      "HTTP/1.1 403 Forbidden forbidden",
    ]);
  }, 60_000);
});

describe("apps/slugbase main server as a role that is not held by row-level security", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  }, 300_000);

  afterAll(async () => {
    await database.drop();
  }, 300_000);

  // The superuser of the test cluster stands for the owner of the tables.
  const production = (extra: Record<string, string> = {}): Record<string, string> => {
    const url = new URL(databaseUrl(database));
    url.username = SUPERUSER.username;
    url.password = SUPERUSER.password;
    return { DATABASE_URL: url.href, MIGRATE_ON_START: "false", DATABASE_MIGRATE_URL: "", ...extra };
  };

  it("refuses to start in production, explaining the two-role setup", async () => {
    const { status, output } = await runServer(production());
    expect(status, output).toBe(1);
    expect(output).not.toContain('"Listening"');
    expect(output).toContain("slugbase_app");
    expect(output).toContain("slugbase_migrator");
    expect(output).toContain("SLUGBASE_ALLOW_OWNER_CONNECTION");
    expect(output).not.toMatch(/postgres(ql)?:\/\//);
  }, 60_000);

  it("starts with SLUGBASE_ALLOW_OWNER_CONNECTION=true and logs the warning", async () => {
    const { status, output } = await runServer(production({ SLUGBASE_ALLOW_OWNER_CONNECTION: "true" }));
    expect(status, output).toBe(0);
    expect(output).toContain('"Listening"');
    expect(output).toContain('"level":"warn"');
    expect(output).toContain("SLUGBASE_ALLOW_OWNER_CONNECTION is set");
    expect(output).not.toMatch(/postgresql?:\/\/[^\s"]*@/);
  }, 60_000);
});
