import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { pruneTestTemplates } from "../src/testing.ts";

// The prune does not count an autovacuum worker as a connection to a template
// (doc 08 section 3.2); every other backend type still counts. An autovacuum
// worker visits every database, a template included, and cannot be started on
// demand, so the test adds the row that one would have in pg_stat_activity at the
// boundary of the query: every
// query of the prune that reads pg_stat_activity reads it with the rows of
// `injected` added as backends of the type named. The query itself runs on the
// real server, so the filter that is under test is the one the prune sends.

const injected = vi.hoisted(() => ({ rows: [] as { database: string; type: string }[], rewritten: 0 }));

const HEX_NAME = /^[a-z0-9_]+$/;

function withInjectedBackends(strings: readonly string[]): string[] {
  const values = injected.rows.map(({ database, type }) => {
    if (!HEX_NAME.test(database) || !HEX_NAME.test(type.replaceAll(" ", "_"))) {
      throw new Error("an injected backend must be named in plain lower-case words");
    }
    return `('${database}'::name, '${type}'::text)`;
  });
  const activity = `(SELECT datname, backend_type FROM pg_stat_activity UNION ALL SELECT * FROM (VALUES ${values.join(", ")}) AS injected(datname, backend_type))`;
  return strings.map((part) => part.replaceAll("pg_stat_activity", activity));
}

vi.mock("postgres", async (importOriginal) => {
  const original = await importOriginal<{ default: typeof postgres }>();
  const wrap = (sql: postgres.Sql): postgres.Sql =>
    new Proxy(sql, {
      apply(target, thisArg, argv: unknown[]) {
        const [strings, ...rest] = argv;
        if (injected.rows.length > 0 && Array.isArray(strings) && strings.some((part) => typeof part === "string" && part.includes("pg_stat_activity"))) {
          injected.rewritten += 1;
          const parts = withInjectedBackends(strings as string[]);
          return Reflect.apply(target, thisArg, [Object.assign(parts, { raw: parts }), ...rest]) as unknown;
        }
        return Reflect.apply(target, thisArg, argv) as unknown;
      },
    });
  const create = new Proxy(original.default, {
    apply: (target, thisArg, argv: unknown[]) => wrap(Reflect.apply(target, thisArg, argv) as postgres.Sql),
  });
  return { ...original, default: create };
});

const serverUrl = process.env["SLUGBASE_TEST_PG_URL"] ?? "postgres://slugbase:slugbase@127.0.0.1:54329/slugbase_dev";
const HOOK_TIMEOUT_MS = 300_000;

const admin = postgres(serverUrl, { max: 1, onnotice: () => undefined });
const createdDatabases: string[] = [];

async function fakeTemplate(options: { allowConnections?: boolean } = {}): Promise<string> {
  const name = `slugbase_tpl_${randomBytes(16).toString("hex")}`;
  await admin.unsafe(`CREATE DATABASE ${name}`);
  createdDatabases.push(name);
  await admin.unsafe(
    `ALTER DATABASE ${name} WITH IS_TEMPLATE true ALLOW_CONNECTIONS ${options.allowConnections === true ? "true" : "false"}`,
  );
  return name;
}

async function exists(name: string): Promise<boolean> {
  const rows = await admin`SELECT 1 FROM pg_database WHERE datname = ${name}`;
  return rows.length === 1;
}

afterEach(() => {
  injected.rows = [];
  injected.rewritten = 0;
});

afterAll(async () => {
  for (const name of createdDatabases) {
    await admin.unsafe(`ALTER DATABASE ${name} WITH IS_TEMPLATE false`).catch(() => undefined);
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  }
  await admin.end({ timeout: 5 });
}, HOOK_TIMEOUT_MS);

describe("pruning a template that other backends are attached to", () => {
  it("drops it when the only backend on it is an autovacuum worker", async () => {
    const template = await fakeTemplate();
    injected.rows = [{ database: template, type: "autovacuum worker" }];
    const result = await pruneTestTemplates({ serverUrl, names: [template], keep: [] });
    expect(injected.rewritten).toBeGreaterThan(0);
    expect(result).toEqual({ dropped: [template], skipped: [] });
    expect(await exists(template)).toBe(false);
  }, HOOK_TIMEOUT_MS);

  // DROP DATABASE signals only autovacuum workers and fails with 55006 while any
  // other backend is attached, so the prune keeps the template for these too.
  it.each(["walsender", "parallel worker", "background worker"])(
    "keeps it while a %s is attached",
    async (type) => {
      const template = await fakeTemplate();
      injected.rows = [{ database: template, type }];
      const result = await pruneTestTemplates({ serverUrl, names: [template], keep: [] });
      expect(injected.rewritten).toBeGreaterThan(0);
      expect(result).toEqual({ dropped: [], skipped: [{ name: template, reason: "connected" }] });
      expect(await exists(template)).toBe(true);
    },
    HOOK_TIMEOUT_MS,
  );

  it("still keeps it while a client session is connected, whatever else is attached", async () => {
    const template = await fakeTemplate({ allowConnections: true });
    const url = new URL(serverUrl);
    url.pathname = `/${template}`;
    const client = postgres(url.href, { max: 1, onnotice: () => undefined });
    try {
      await client`SELECT 1`;
      injected.rows = [{ database: template, type: "autovacuum worker" }];
      const result = await pruneTestTemplates({ serverUrl, names: [template], keep: [] });
      expect(injected.rewritten).toBeGreaterThan(0);
      expect(result).toEqual({ dropped: [], skipped: [{ name: template, reason: "connected" }] });
      expect(await exists(template)).toBe(true);
    } finally {
      await client.end({ timeout: 5 });
    }
  }, HOOK_TIMEOUT_MS);
});
