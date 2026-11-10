import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CE_CHAIN } from "@slugbase/db";
import { describe, expect, it } from "vitest";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../vitest.shared.ts";
import {
  LOCK_LIMIT_MS,
  MigrationLockError,
  assertLocksWithinLimit,
  holdsOf,
  isNonTransactional,
  lockViolations,
  migratorUrl,
  prepareMigrationInstance,
  seedRequirements,
  serverConnection,
  type MigrationTiming,
} from "../src/perf/index.ts";
import { buildLargeInstance, largeSeedScript } from "../src/seed/index.ts";

const timing = (file: string, lock: MigrationTiming["lock"], nonTransactional = false): MigrationTiming => ({
  chain: "core",
  tag: file.replace(/\.sql$/, ""),
  file,
  wallMs: 10,
  nonTransactional,
  lock,
});

describe("the holds of a lock sampler", () => {
  it("are the longest run of polls that see a relation, and a gap ends a run", () => {
    const polls = [
      { t: 100.0, relations: ["public.a"] },
      { t: 100.5, relations: ["public.a", "public.b"] },
      { t: 101.0, relations: ["public.a"] },
      { t: 101.5, relations: [] },
      { t: 102.0, relations: ["public.a"] },
      { t: 102.1, relations: ["public.a"] },
    ];
    expect(holdsOf(polls)).toEqual([
      { relation: "public.a", heldMs: 1000 },
      { relation: "public.b", heldMs: 0 },
    ]);
  });

  it("are empty when no poll saw a lock", () => {
    expect(holdsOf([{ t: 1, relations: [] }])).toEqual([]);
    expect(holdsOf([])).toEqual([]);
  });
});

describe("the lock limit", () => {
  it("is 1 s, and fails a migration that holds ACCESS EXCLUSIVE for longer, naming its file and relation", () => {
    expect(LOCK_LIMIT_MS).toBe(1_000);
    const slow = timing("20300101000002_rewrite_rows.sql", { relation: "public.perf_rows", heldMs: 1_001 });
    const timings = [timing("20300101000001_add_note_column.sql", { relation: "public.perf_rows", heldMs: 1_000 }), slow, timing("20300101000003_none.sql", undefined)];
    expect(lockViolations(timings)).toEqual([slow]);
    expect(() => {
      assertLocksWithinLimit(timings);
    }).toThrow(MigrationLockError);
    expect(() => {
      assertLocksWithinLimit(timings);
    }).toThrow(/20300101000002_rewrite_rows\.sql \(chain core\) on public\.perf_rows for 1001 ms/u);
  });

  it("passes migrations at the limit or with no lock seen, and judges no non-transactional step", () => {
    const timings = [
      timing("a.sql", { relation: "public.t", heldMs: 1_000 }),
      timing("b.sql", undefined),
      timing("c.sql", { relation: "public.t", heldMs: 5_000 }, true),
    ];
    expect(lockViolations(timings)).toEqual([]);
    expect(() => {
      assertLocksWithinLimit(timings);
    }).not.toThrow();
  });
});

describe("what the seed needs", () => {
  it("is read from the seed script of the large instance: its tables, the columns it writes and the system operations it calls with their arguments", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
    const requirements = seedRequirements(largeSeedScript(buildLargeInstance(), "$argon2id$stand-in"));
    expect([...requirements.columns.keys()].sort()).toEqual([
      "accounts",
      "bookmark_shares",
      "bookmark_tags",
      "bookmarks",
      "folder_bookmarks",
      "folder_shares",
      "folders",
      "tags",
      "team_members",
      "teams",
      "workspace_members",
      "workspaces",
    ]);
    expect(requirements.columns.get("accounts")).toEqual(["is_instance_admin"]);
    expect(requirements.columns.get("workspaces")).toEqual(["bookmark_count"]);
    expect(requirements.columns.get("bookmarks")).toContain("plan_archived_at");
    expect(requirements.columns.get("folder_shares")).toContain("target_team_id");
    expect(requirements.functions).toEqual([
      { name: "sys_create_account", args: 6 },
      { name: "sys_create_workspace", args: 3 },
    ]);
  });

  it("counts the arguments of a call outside quoted strings, so an email with a comma or a parenthesis does not change the count", () => {
    const tricky = seedRequirements(
      "INSERT INTO public.t (a, b) VALUES (1, 2); SELECT public.sys_create_account('x', 'a,b)c@example.test', (1, 2), 'it''s', 5, true);",
    );
    expect(tricky.functions).toEqual([{ name: "sys_create_account", args: 6 }]);
  });

  it("refuses a script it reads nothing from", () => {
    expect(() => seedRequirements("SELECT 1;")).toThrow(/cannot be read/u);
  });
});

describe("a non-transactional file", () => {
  const read = (tag: string): string => readFileSync(join(CE_CHAIN.folder, `${tag}.sql`), "utf8");

  it("is one whose first line is the marker `migrate` looks for, and a concurrent index build of the CE chain is one", () => {
    expect(isNonTransactional(read("20261030185909_index_audit_events_account"))).toBe(true);
    expect(isNonTransactional(read("20261014132647_add_workspaces"))).toBe(false);
    expect(isNonTransactional("-- slugbase:non-transactional  \nCREATE INDEX CONCURRENTLY i ON t (a);")).toBe(true);
    expect(isNonTransactional("CREATE TABLE t (a int);\n-- slugbase:non-transactional")).toBe(false);
  });
});

describe("the server and the migrator", () => {
  it("are read from the harness URL, decoded, with the database replaced when one is given", () => {
    const connection = serverConnection("postgres://su%40x:p%2Fw@127.0.0.1:54329/slugbase_dev", "test_0123456789abcdef");
    expect(connection).toEqual({ host: "127.0.0.1", port: 54329, database: "test_0123456789abcdef", username: "su@x", password: "p/w" });
    expect(serverConnection("postgres://u:p@[::1]/").host).toBe("::1");
    expect(() => serverConnection("mysql://u:p@h/d")).toThrow(/not a PostgreSQL/u);
  });

  it("connects as slugbase_migrator, with the host in brackets for an IPv6 address", () => {
    expect(migratorUrl({ host: "127.0.0.1", port: 54329, database: "x", username: "u", password: "p" }, "test_0123456789abcdef")).toBe(
      "postgres://slugbase_migrator:slugbase_migrator_dev_only@127.0.0.1:54329/test_0123456789abcdef",
    );
    expect(migratorUrl({ host: "::1", port: 5432, database: "x", username: "u", password: "p" }, "d")).toContain("@[::1]:5432/d");
  });
});

describe("a migration instance", () => {
  const base = { path: "/usr/bin", harnessUrl: undefined, bookmarks: 5, workspaces: 1 } as const;

  it("is refused before anything is created when the release's migrations are not the first of the CE chain", async () => {
    await expect(prepareMigrationInstance({ ...base, serverUrl: "postgres://u:p@127.0.0.1:54329/postgres", released: ["20200101000000_not_ours"] })).rejects.toThrow(/not the first migrations/u);
  });

  it("is refused on a server that is neither on this machine nor the harness's, before anything is created", async () => {
    await expect(prepareMigrationInstance({ ...base, serverUrl: "postgres://u:p@db.internal.example:5432/postgres", released: [] })).rejects.toThrow(/on this machine/u);
  });
});
