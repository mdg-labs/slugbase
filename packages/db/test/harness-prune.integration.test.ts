import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MigrationChain } from "../src/migrate.ts";
import { createTestDatabase, dropTestTemplate, pruneTestTemplates, testTemplateName } from "../src/testing.ts";

// The prune of stale templates (doc 08 section 3.2). The development Postgres
// is shared with other checkouts, so every call here names the templates it
// may drop: the ones this file creates, never the ones other runs depend on.

const PRUNE_SCRIPT = new URL("../scripts/prune-templates.ts", import.meta.url).pathname;
const FIXTURE = new URL("./migrations/fixtures/restored/", import.meta.url).pathname;
const serverUrl = process.env["SLUGBASE_TEST_PG_URL"] ?? "postgres://slugbase:slugbase@127.0.0.1:54329/slugbase_dev";
const HOOK_TIMEOUT_MS = 300_000;
const execFileAsync = promisify(execFile);

const admin = postgres(serverUrl, { max: 1, onnotice: () => undefined });
const createdDatabases: string[] = [];

// A template that needs no migrations: the prune looks at names, locks and
// connections only.
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

function extraChain(folders: string[]): MigrationChain {
  const folder = mkdtempSync(join(tmpdir(), "slugbase-prune-"));
  folders.push(folder);
  cpSync(FIXTURE, folder, { recursive: true });
  const name = `prune${randomBytes(4).toString("hex")}`;
  return { name, folder, bookkeepingTable: `migrations_${name}` };
}

afterAll(async () => {
  for (const name of createdDatabases) {
    await admin.unsafe(`ALTER DATABASE ${name} WITH IS_TEMPLATE false`).catch(() => undefined);
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  }
  await admin.end({ timeout: 5 });
}, HOOK_TIMEOUT_MS);

describe("pruning stale templates", () => {
  it("drops a template nothing uses and leaves the one it is told to keep", async () => {
    const stale = await fakeTemplate();
    const current = await fakeTemplate();
    const result = await pruneTestTemplates({ serverUrl, names: [stale, current], keep: [current] });
    expect(result.dropped).toEqual([stale]);
    expect(result.skipped).toEqual([{ name: current, reason: "current" }]);
    expect(await exists(stale)).toBe(false);
    expect(await exists(current)).toBe(true);
  }, HOOK_TIMEOUT_MS);

  it("keeps the template of the current migration hash by default", async () => {
    const database = await createTestDatabase({ serverUrl });
    await database.drop();
    const current = testTemplateName();
    const result = await pruneTestTemplates({ serverUrl, names: [current] });
    expect(result.dropped).toEqual([]);
    expect(result.skipped).toEqual([{ name: current, reason: "current" }]);
    expect(await exists(current)).toBe(true);
  }, HOOK_TIMEOUT_MS);

  it("never touches a database outside the slugbase_tpl_ and test_ names", async () => {
    // The development database exists on a developer's server and not on the
    // CI service, so the test asserts it is left as it was found.
    const devBefore = await exists("slugbase_dev");
    const stale = await fakeTemplate();
    const decoy = `other_${randomBytes(8).toString("hex")}`;
    await admin.unsafe(`CREATE DATABASE ${decoy}`);
    createdDatabases.push(decoy);
    const lookalike = `slugbase_tpl_${randomBytes(4).toString("hex")}`;
    await admin.unsafe(`CREATE DATABASE ${lookalike}`);
    createdDatabases.push(lookalike);
    const result = await pruneTestTemplates({ serverUrl, names: [stale, decoy, lookalike, "slugbase_dev"], keep: [] });
    expect(result.dropped).toEqual([stale]);
    expect(result.skipped).toEqual([]);
    for (const name of [decoy, lookalike]) {
      expect(await exists(name)).toBe(true);
    }
    expect(await exists("slugbase_dev")).toBe(devBefore);
  }, HOOK_TIMEOUT_MS);

  it("skips a template whose build lock another process holds", async () => {
    const held = await fakeTemplate();
    const free = await fakeTemplate();
    const holder = postgres(serverUrl, { max: 1, onnotice: () => undefined });
    try {
      await holder`SELECT pg_advisory_lock(hashtext(${`slugbase.test-template.${held}`}))`;
      const result = await pruneTestTemplates({ serverUrl, names: [held, free], keep: [] });
      expect(result.dropped).toEqual([free]);
      expect(result.skipped).toEqual([{ name: held, reason: "building" }]);
      expect(await exists(held)).toBe(true);
    } finally {
      await holder.end({ timeout: 5 });
    }
    expect((await pruneTestTemplates({ serverUrl, names: [held], keep: [] })).dropped).toEqual([held]);
  }, HOOK_TIMEOUT_MS);

  it("skips a template with an open connection", async () => {
    const connected = await fakeTemplate({ allowConnections: true });
    const url = new URL(serverUrl);
    url.pathname = `/${connected}`;
    const client = postgres(url.href, { max: 1, onnotice: () => undefined });
    try {
      await client`SELECT 1`;
      const result = await pruneTestTemplates({ serverUrl, names: [connected], keep: [] });
      expect(result.dropped).toEqual([]);
      expect(result.skipped).toEqual([{ name: connected, reason: "connected" }]);
      expect(await exists(connected)).toBe(true);
      expect(
        (await admin<{ template: boolean }[]>`SELECT datistemplate AS template FROM pg_database WHERE datname = ${connected}`)[0]
          ?.template,
      ).toBe(true);
    } finally {
      await client.end({ timeout: 5 });
    }
  }, HOOK_TIMEOUT_MS);

  describe("with a test database cloned from a template", () => {
    const folders: string[] = [];
    const chains = [extraChain(folders)];
    const template = testTemplateName(chains);

    afterAll(async () => {
      await dropTestTemplate(template, { serverUrl });
      for (const folder of folders) {
        rmSync(folder, { recursive: true, force: true });
      }
    }, HOOK_TIMEOUT_MS);

    it("is kept while the test database exists and dropped once it is gone", async () => {
      const database = await createTestDatabase({ serverUrl, chains });
      const unused = await fakeTemplate();
      try {
        const result = await pruneTestTemplates({ serverUrl, names: [template, unused], keep: [] });
        expect(result.dropped).toEqual([unused]);
        expect(result.skipped).toEqual([{ name: template, reason: "in use" }]);
        expect(await exists(template)).toBe(true);
        await database.app`SELECT 1`;
      } finally {
        await database.drop();
      }
      const after = await pruneTestTemplates({ serverUrl, names: [template], keep: [] });
      // The whole result, so that a template kept for a reason names it.
      expect(after).toEqual({ dropped: [template], skipped: [] });
      expect(await exists(template)).toBe(false);
    }, HOOK_TIMEOUT_MS);

    it("is rebuilt by the next test database after it was pruned", async () => {
      const database = await createTestDatabase({ serverUrl, chains });
      try {
        expect(database.template).toEqual({ name: template, built: true });
      } finally {
        await database.drop();
      }
    }, HOOK_TIMEOUT_MS);
  });

  describe("the package script", () => {
    let stale: string;
    let current: string;

    beforeAll(async () => {
      stale = await fakeTemplate();
      current = await fakeTemplate();
    }, HOOK_TIMEOUT_MS);

    it("drops the templates named on its command line and reports them", async () => {
      const { stdout } = await execFileAsync(process.execPath, [PRUNE_SCRIPT, stale, current], {
        env: { ...process.env, SLUGBASE_TEST_PG_URL: serverUrl },
        timeout: 60_000,
      });
      expect(stdout).toContain(`dropped ${stale}`);
      expect(await exists(stale)).toBe(false);
      expect(await exists(current)).toBe(false);
    }, HOOK_TIMEOUT_MS);
  });
});
