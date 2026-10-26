import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, useCluster } from "../src/testing.ts";

// Two harness users at once (doc 08 section 3.2). The cluster lock keeps the
// roles of the cluster still while test databases use them: a test database
// holds it shared for its whole life, and a test that changes the roles holds it
// exclusively for that step only. A holder here is a process of its own, as the
// test file of another run would be.
//
// Advisory locks belong to the database a session is connected to. The harness
// connects to the database of its server URL, so these tests point it at a
// database of their own: they meet only each other, and another run's roles test
// neither delays them nor is delayed by them. The processes of one test hold
// the lock while the test waits for another of them, so one foreign request
// queued between them would end in a wait for each other.

const HOLDER = new URL("./support/cluster-holder.ts", import.meta.url).pathname;
const CLUSTER_LOCK_KEY = 7_354_190_025;
const HARNESS = "slugbase-test-harness";
// Waiting for a template build of another run counts against both.
const STEP_TIMEOUT_MS = 300_000;
const TEST_TIMEOUT_MS = 300_000;

const rootUrl = process.env["SLUGBASE_TEST_PG_URL"] ?? "postgres://slugbase:slugbase@127.0.0.1:54329/slugbase_dev";
const scratch = `test_cluster_lock_${randomBytes(6).toString("hex")}`;
const scratchUrl = (() => {
  const url = new URL(rootUrl);
  url.pathname = `/${scratch}`;
  return url.href;
})();
const options = { serverUrl: scratchUrl };

class Holder {
  readonly child: ChildProcessByStdio<Writable, Readable, null>;
  private readonly lines: string[] = [];
  private readonly waiting: (() => void)[] = [];

  constructor() {
    this.child = spawn(process.execPath, [HOLDER], {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, SLUGBASE_TEST_PG_URL: scratchUrl },
    });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      this.lines.push(line);
      for (const wake of this.waiting.splice(0)) {
        wake();
      }
    });
  }

  async answer(): Promise<string> {
    const deadline = Date.now() + STEP_TIMEOUT_MS;
    while (this.lines.length === 0) {
      if (Date.now() > deadline) {
        throw new Error("the holder process did not answer in time");
      }
      await Promise.race([new Promise<void>((wake) => this.waiting.push(wake)), sleep(500)]);
    }
    return this.lines.shift() ?? "";
  }

  async ask(command: string, expected: string): Promise<void> {
    this.send(command);
    expect(await this.answer()).toBe(expected);
  }

  send(command: string): void {
    this.child.stdin.write(`${command}\n`);
  }

  get running(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null;
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    const exited = new Promise<void>((resolve) => {
      this.child.once("exit", () => {
        resolve();
      });
    });
    this.send("exit");
    await Promise.race([exited, sleep(STEP_TIMEOUT_MS)]);
    this.child.kill();
  }
}

let admin: postgres.Sql;
const holders: Holder[] = [];

function startHolder(): Holder {
  const holder = new Holder();
  holders.push(holder);
  return holder;
}

beforeAll(async () => {
  admin = postgres(rootUrl, { max: 1, onnotice: () => undefined });
  // The template exists before the tests meet: its build lock is a lock of the database
  // too, so a template built here could be built by another run at the same time.
  await (await createTestDatabase()).drop();
  await admin.unsafe(`CREATE DATABASE ${scratch}`);
}, STEP_TIMEOUT_MS);

afterEach(async () => {
  await Promise.all(holders.splice(0).map((holder) => holder.stop()));
});

afterAll(async () => {
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`);
  } finally {
    await admin.end({ timeout: 5 });
  }
});

// The backends of the harness that hold, or ask for, the cluster lock of the database of these tests.
async function requests(mode: "ExclusiveLock" | "ShareLock", granted: boolean): Promise<number[]> {
  const rows = await admin<{ pid: number }[]>`
    SELECT l.pid FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
    WHERE l.locktype = 'advisory' AND (l.classid::bigint << 32 | l.objid::bigint) = ${CLUSTER_LOCK_KEY}
      AND l.database = (SELECT oid FROM pg_database WHERE datname = ${scratch})
      AND l.mode = ${mode} AND l.granted = ${granted} AND a.application_name = ${HARNESS}
    ORDER BY l.pid`;
  return rows.map((row) => row.pid);
}

async function waitFor(what: string, probe: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  while (!(await probe())) {
    if (Date.now() > deadline) {
      throw new Error(`gave up waiting for ${what}`);
    }
    await sleep(50);
  }
}

async function settled(promise: Promise<unknown>, afterMs: number): Promise<boolean> {
  return Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    sleep(afterMs).then(() => false),
  ]);
}

describe("a test database beside a process that changes the roles of the cluster", () => {
  it("waits for the exclusive step of that process and not for the rest of its run", async () => {
    const holder = startHolder();
    await holder.ask("use", "using");
    await holder.ask("lock-exclusive", "exclusive");
    expect(await requests("ExclusiveLock", true)).toHaveLength(1);

    const created = createTestDatabase(options);
    const outcome = created.then(
      (database) => ({ database }),
      (error: unknown) => ({ error }),
    );
    await waitFor("the test database to ask for the cluster", async () => (await requests("ShareLock", false)).length > 0);
    expect(await settled(created, 500)).toBe(false);

    await holder.ask("unlock-exclusive", "shared");
    const result = await outcome;
    // The holder is still running, as the rest of its test file would be, and holds the cluster.
    expect(holder.running).toBe(true);
    expect(await requests("ShareLock", true)).toHaveLength(2);
    expect("database" in result).toBe(true);
    if ("database" in result) {
      await result.database.drop();
    }
  }, TEST_TIMEOUT_MS);

  it("is created at once beside a process that only uses the cluster", async () => {
    const holder = startHolder();
    await holder.ask("use", "using");
    const database = await createTestDatabase(options);
    expect(holder.running).toBe(true);
    await database.drop();
  }, TEST_TIMEOUT_MS);
});

describe("a process that changes the roles of the cluster", () => {
  it("waits for the test databases of other processes, and for each of them to be dropped", async () => {
    const database = startHolder();
    await database.ask("database", "database");
    const changing = startHolder();
    await changing.ask("use", "using");

    changing.send("lock-exclusive");
    const exclusive = changing.answer();
    await waitFor("the exclusive request", async () => (await requests("ExclusiveLock", false)).length > 0);
    expect(await settled(exclusive, 500)).toBe(false);
    expect(await requests("ExclusiveLock", true)).toHaveLength(0);

    await database.ask("drop-database", "dropped");
    expect(await exclusive).toBe("exclusive");
    expect(await requests("ExclusiveLock", true)).toHaveLength(1);
  }, TEST_TIMEOUT_MS);

  it("refuses to wait for a test database of its own process", async () => {
    const database = await createTestDatabase(options);
    const cluster = await useCluster(options);
    try {
      await expect(cluster.lockExclusive()).rejects.toThrow(/test database/);
    } finally {
      await cluster.release();
      await database.drop();
    }
  }, TEST_TIMEOUT_MS);

  it("holds the cluster shared again once the step is over, and lets go of it when released", async () => {
    const cluster = await useCluster(options);
    expect(await requests("ShareLock", true)).toHaveLength(1);

    const endStep = await cluster.lockExclusive();
    expect(await requests("ShareLock", true)).toHaveLength(0);
    expect(await requests("ExclusiveLock", true)).toHaveLength(1);

    await endStep();
    expect(await requests("ExclusiveLock", true)).toHaveLength(0);
    expect(await requests("ShareLock", true)).toHaveLength(1);

    await cluster.release();
    expect(await requests("ShareLock", true)).toHaveLength(0);
  }, TEST_TIMEOUT_MS);
});
