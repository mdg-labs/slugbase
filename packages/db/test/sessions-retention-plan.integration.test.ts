import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";

// The plan of the sessions rule of sys_retention_purge on a table of 20 060 sessions (doc 05 sections 2.1 and 6): 20 000 live ones, 30 past only their
// sliding expiry and 30 past only their absolute expiry. EXPLAIN runs nothing; the statement is read from the function as the database holds it and planned
// with the value of the clock known, which is the custom plan PL/pgSQL chooses while it costs less than the generic one. The generic plan, made without
// the value, reads a third of the table whatever the indexes are (a range on an unknown bound), so it is not the plan the purge runs with and is not asserted.
const HOOK_TIMEOUT_MS = 300_000;
const LIVE = 20_000;
const DUE_PER_ARM = 30;

let db: TestDatabase;
let statement = "";

beforeAll(async () => {
  db = await createTestDatabase();
  const accountId = freshId();
  await seedAccount(db, { id: accountId, email: "sessions-retention-plan@example.test", passwordHash: "$argon2id$stub" });
  await asSystem(db, (tx) => tx`
    INSERT INTO sessions (id, token_hash, account_id, level, remember, expires_at, absolute_expires_at)
    SELECT gen_random_uuid(), sha256(('live' || n)::bytea), ${accountId}::uuid, 'full', false,
           now() + interval '1 day' + n * interval '1 second', now() + interval '10 days' + n * interval '1 second'
    FROM generate_series(1, ${LIVE}) AS n`);
  await asSystem(db, (tx) => tx`
    INSERT INTO sessions (id, token_hash, account_id, level, remember, expires_at, absolute_expires_at)
    SELECT gen_random_uuid(), sha256(('sliding' || n)::bytea), ${accountId}::uuid, 'full', false,
           now() - interval '1 hour' - n * interval '1 second', now() + interval '10 days'
    FROM generate_series(1, ${DUE_PER_ARM}) AS n`);
  await asSystem(db, (tx) => tx`
    INSERT INTO sessions (id, token_hash, account_id, level, remember, expires_at, absolute_expires_at)
    SELECT gen_random_uuid(), sha256(('absolute' || n)::bytea), ${accountId}::uuid, 'full', false,
           now() + interval '1 day', now() - interval '1 hour' - n * interval '1 second'
    FROM generate_series(1, ${DUE_PER_ARM}) AS n`);
  await db.owner.unsafe("VACUUM (ANALYZE) sessions");

  const rows = await db.owner<{ source: string }[]>`
    SELECT prosrc AS source FROM pg_proc WHERE proname = 'sys_retention_purge' AND pronamespace = 'public'::regnamespace AND pronargs = 1`;
  const found = rows.flatMap((row) => /DELETE FROM public\.sessions[\s\S]*?FOR UPDATE SKIP LOCKED\s*\);/.exec(row.source)?.[0] ?? []);
  expect(found, "sys_retention_purge deletes sessions once").toHaveLength(1);
  statement = (found[0] ?? "").replace(/;$/, "").replaceAll("v_now", "$1").replaceAll("c_batch", "5000");
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await db.drop();
}, HOOK_TIMEOUT_MS);

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  Plans?: PlanNode[];
}

function nodesOf(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(nodesOf)];
}

let prepared = 0;

async function planOf(sql: string): Promise<PlanNode[]> {
  prepared += 1;
  const name = `sessions_purge_${String(prepared)}`;
  const explain = async (tx: postgres.TransactionSql): Promise<PlanNode | undefined> => {
    await tx.unsafe("SET LOCAL plan_cache_mode = force_custom_plan");
    await tx.unsafe(`PREPARE ${name} (timestamptz) AS ${sql}`);
    const rows = await tx.unsafe<{ "QUERY PLAN": { Plan: PlanNode }[] }[]>(`EXPLAIN (FORMAT JSON) EXECUTE ${name}(now())`);
    return rows[0]?.["QUERY PLAN"][0]?.Plan;
  };
  const plan = await asSystem(db, explain);
  if (plan === undefined) {
    throw new Error("EXPLAIN returned no plan");
  }
  return nodesOf(plan);
}

describe(`the sessions rule of the retention purge on a table of ${String(LIVE + 2 * DUE_PER_ARM)} sessions`, () => {
  it("holds the sessions the plans are made for", async () => {
    const [row] = await asSystem(db, (tx) => tx<{ total: string; sliding: string; absolute: string }[]>`
      SELECT count(*)::text AS total,
             count(*) FILTER (WHERE expires_at <= now())::text AS sliding,
             count(*) FILTER (WHERE absolute_expires_at <= now())::text AS absolute
      FROM sessions`);
    expect(row).toEqual({ total: String(LIVE + 2 * DUE_PER_ARM), sliding: String(DUE_PER_ARM), absolute: String(DUE_PER_ARM) });
  });

  it("reads sessions through sessions_expires_at_idx and sessions_absolute_expires_at_idx with no sequential scan of sessions", async () => {
    const nodes = await planOf(statement);

    expect(nodes.filter((node) => node["Node Type"] === "Seq Scan" && node["Relation Name"] === "sessions")).toEqual([]);
    const indexes = nodes.map((node) => node["Index Name"]).filter((name) => name !== undefined);
    expect(indexes).toContain("sessions_expires_at_idx");
    expect(indexes).toContain("sessions_absolute_expires_at_idx");
  });

  it("deletes the sessions past either expiry, and only those", async () => {
    const [row] = await asSystem(db, (tx) => tx<{ table_name: string; deleted: string }[]>`SELECT table_name, deleted::text FROM sys_retention_purge(0) WHERE table_name = 'sessions'`);
    expect(row).toEqual({ table_name: "sessions", deleted: String(2 * DUE_PER_ARM) });
    const [left] = await asSystem(db, (tx) => tx<{ total: string }[]>`SELECT count(*)::text AS total FROM sessions`);
    expect(left?.total).toBe(String(LIVE));
  });
});
