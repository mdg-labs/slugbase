import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";

// The plan of the lookups by the creator of a workspace on a table of 20 080 workspaces (doc 05 section 2.2): 20 000 made by 25 other accounts, 60 with
// no creator (the account was deleted) and 20 made by the account asked about. EXPLAIN runs nothing; each statement is planned with a custom and with a
// generic plan.
const HOOK_TIMEOUT_MS = 300_000;
const WORKSPACES = 20_000;
const CREATORS = 25;

let db: TestDatabase;
let accountId: string;

beforeAll(async () => {
  db = await createTestDatabase();
  accountId = freshId();
  await seedAccount(db, { id: accountId, email: "workspace-creator-plan@example.test", passwordHash: "$argon2id$stub" });
  for (let n = 1; n <= CREATORS; n += 1) {
    await seedAccount(db, { id: `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`, email: `creator${String(n)}@example.test`, passwordHash: "$argon2id$stub" });
  }
  await asSystem(db, (tx) => tx`
    INSERT INTO workspaces (id, name, created_by)
    SELECT gen_random_uuid(), 'Workspace ' || n, ('00000000-0000-7000-8000-' || lpad((1 + n % ${CREATORS}::int)::text, 12, '0'))::uuid
    FROM generate_series(1, ${WORKSPACES}) AS n`);
  await asSystem(db, (tx) => tx`INSERT INTO workspaces (id, name) SELECT gen_random_uuid(), 'Orphan ' || n FROM generate_series(1, 60) AS n`);
  await asSystem(db, (tx) => tx`INSERT INTO workspaces (id, name, created_by) SELECT gen_random_uuid(), 'Mine ' || n, ${accountId}::uuid FROM generate_series(1, 20) AS n`);
  await db.owner.unsafe("VACUUM (ANALYZE) workspaces");
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await db.drop();
}, HOOK_TIMEOUT_MS);

interface PlanNode {
  "Node Type": string;
  "Index Name"?: string;
  Plans?: PlanNode[];
}

function nodesOf(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(nodesOf)];
}

let prepared = 0;

async function planOf(sql: string, mode: "force_custom_plan" | "force_generic_plan"): Promise<PlanNode[]> {
  prepared += 1;
  const name = `creator_lookup_${String(prepared)}`;
  const explain = async (tx: postgres.TransactionSql): Promise<PlanNode | undefined> => {
    await tx.unsafe(`SET LOCAL plan_cache_mode = ${mode}`);
    await tx.unsafe(`PREPARE ${name} (uuid) AS ${sql}`);
    const rows = await tx.unsafe<{ "QUERY PLAN": { Plan: PlanNode }[] }[]>(`EXPLAIN (FORMAT JSON) EXECUTE ${name}('${accountId}')`);
    return rows[0]?.["QUERY PLAN"][0]?.Plan;
  };
  const plan = await asSystem(db, explain);
  if (plan === undefined) {
    throw new Error("EXPLAIN returned no plan");
  }
  return nodesOf(plan);
}

// The statements that read workspaces by their creator: the foreign-key action of `created_by` (ON DELETE SET NULL), which PostgreSQL runs on the delete
// of an account as a lookup of the referencing rows (read here as a SELECT, because it runs as the owner of the table), and a lookup of the workspaces one
// account created. Neither reads the table sequentially: each is served by workspaces_created_by_idx, which is partial on a creator that is set, a
// condition the equality implies.
const STATEMENTS: readonly { name: string; sql: string }[] = [
  { name: "the foreign-key action on created_by", sql: "SELECT ctid FROM ONLY public.workspaces WHERE $1 OPERATOR(pg_catalog.=) created_by" },
  { name: "the workspaces an account created that are not being deleted", sql: "SELECT id FROM public.workspaces WHERE created_by = $1 AND deleting_at IS NULL ORDER BY id" },
];

describe(`the lookups by the creator on a table of ${String(WORKSPACES + 80)} workspaces`, () => {
  it("holds the workspaces the plans are made for", async () => {
    const [row] = await asSystem(db, (tx) => tx<{ total: string; mine: string; orphans: string }[]>`
      SELECT count(*)::text AS total, count(*) FILTER (WHERE created_by = ${accountId})::text AS mine, count(*) FILTER (WHERE created_by IS NULL)::text AS orphans FROM workspaces`);
    expect(row).toEqual({ total: String(WORKSPACES + 80), mine: "20", orphans: "60" });
  });

  for (const statement of STATEMENTS) {
    for (const mode of ["force_custom_plan", "force_generic_plan"] as const) {
      it(`plans ${statement.name} from workspaces_created_by_idx with no sequential scan (${mode})`, async () => {
        const nodes = await planOf(statement.sql, mode);

        expect(nodes.filter((node) => node["Node Type"] === "Seq Scan")).toEqual([]);
        expect(nodes.map((node) => node["Index Name"]).filter((name) => name !== undefined)).toEqual(["workspaces_created_by_idx"]);
      });
    }
  }

  it("reads the index when the foreign key of an account's workspaces is followed on the delete of the account", async () => {
    const creator = freshId();
    await seedAccount(db, { id: creator, email: "workspace-creator-deleted@example.test", passwordHash: "$argon2id$stub" });
    await asSystem(db, (tx) => tx`INSERT INTO workspaces (id, name, created_by) SELECT gen_random_uuid(), 'Former ' || n, ${creator}::uuid FROM generate_series(1, 5) AS n`);
    const scans = async (): Promise<number> => {
      const [row] = await db.owner<{ scans: string }[]>`
        SELECT idx_scan::text AS scans FROM pg_stat_user_indexes WHERE relname = 'workspaces' AND indexrelname = 'workspaces_created_by_idx'`;
      return Number(row?.scans);
    };
    const before = await scans();

    await asSystem(db, async (tx) => {
      await tx`SELECT pg_stat_force_next_flush()`;
      await tx`DELETE FROM accounts WHERE id = ${creator}::uuid`;
    });

    expect(await scans()).toBeGreaterThan(before);
    const [row] = await asSystem(db, (tx) => tx<{ kept: string; named: string }[]>`
      SELECT count(*) FILTER (WHERE name LIKE 'Former %')::text AS kept, count(*) FILTER (WHERE created_by = ${creator}::uuid)::text AS named FROM workspaces`);
    expect(row).toEqual({ kept: "5", named: "0" });
  });
});
