import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import type { MigrationChain } from "../src/migrate.ts";
import { dropTestTemplate, testTemplateName } from "../src/testing.ts";

// The build of a template (doc 08 section 3.2) for a chain list of its own, so
// that every run builds one. Each start is a process of its own, as a second
// worker or checkout would be. This file holds no test database itself: the
// cluster lock is shared, and a shared request queues behind a waiting
// exclusive one, so a holder must never wait for a later request.

const START_DATABASE = new URL("./support/start-database.ts", import.meta.url).pathname;
const execFileAsync = promisify(execFile);

interface Started {
  name: string;
  template: { name: string; built: boolean };
  core: number;
}

const HOOK_TIMEOUT_MS = 300_000;
const MIGRATIONS = new URL("../migrations/", import.meta.url);
const FIXTURE = new URL("./migrations/fixtures/restored/", import.meta.url).pathname;
const serverUrl = process.env["SLUGBASE_TEST_PG_URL"] ?? "postgres://slugbase:slugbase@127.0.0.1:54329/slugbase_dev";

interface Journal {
  entries: { tag: string }[];
}
const journalLength = (JSON.parse(readFileSync(new URL("meta/_journal.json", MIGRATIONS), "utf8")) as Journal)
  .entries.length;

async function start(chains: MigrationChain[]): Promise<Started> {
  const { stdout } = await execFileAsync(process.execPath, [START_DATABASE, JSON.stringify(chains)], {
    timeout: HOOK_TIMEOUT_MS,
  });
  return JSON.parse(stdout) as Started;
}

describe("a template for a chain list the cluster has not seen", () => {
  const folders: string[] = [];
  const extra = (): MigrationChain => {
    const folder = mkdtempSync(join(tmpdir(), "slugbase-tpl-"));
    folders.push(folder);
    cpSync(FIXTURE, folder, { recursive: true });
    const name = `harness${randomBytes(4).toString("hex")}`;
    return { name, folder, bookkeepingTable: `migrations_${name}` };
  };
  const created: string[] = [];

  afterAll(async () => {
    for (const name of created) {
      await dropTestTemplate(name);
    }
    for (const folder of folders) {
      rmSync(folder, { recursive: true, force: true });
    }
  }, HOOK_TIMEOUT_MS);

  it("is built once when several runs start together, and applies the extra chain after the CE chain", async () => {
    const chains = [extra()];
    created.push(testTemplateName(chains));
    const starts = await Promise.all(Array.from({ length: 4 }, () => start(chains)));
    expect(starts.filter((start) => start.template.built)).toHaveLength(1);
    expect(new Set(starts.map((start) => start.template.name))).toEqual(new Set([testTemplateName(chains)]));
    expect(new Set(starts.map((start) => start.name)).size).toBe(4);
    for (const start of starts) {
      expect(start.core).toBe(journalLength);
    }
  }, HOOK_TIMEOUT_MS);

  it("is rebuilt when the build left a database that was never marked as a template", async () => {
    const chains = [extra()];
    const name = testTemplateName(chains);
    created.push(name);
    expect((await start(chains)).template.built).toBe(true);
    expect((await start(chains)).template.built).toBe(false);
    // A build that died before it marked the database leaves it unmarked.
    const admin = postgres(serverUrl);
    try {
      await admin.unsafe(`ALTER DATABASE ${name} WITH IS_TEMPLATE false`);
      expect((await start(chains)).template.built).toBe(true);
      const marked = await admin<{ template: boolean }[]>`SELECT datistemplate AS template FROM pg_database WHERE datname = ${name}`;
      expect(marked[0]?.template).toBe(true);
    } finally {
      await admin.end({ timeout: 5 });
    }
  }, HOOK_TIMEOUT_MS);
});
