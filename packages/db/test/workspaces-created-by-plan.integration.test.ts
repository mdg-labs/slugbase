import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";

// The plan of the lookups by the creator of a workspace on a table of 20 080 workspaces (doc 05 section 2.2): 20 000 made by 2 000 other accounts, 60 with
// no creator (the account was deleted) and 20 made by the account asked about. EXPLAIN runs nothing; each statement is planned with a custom and with a
// generic plan.
const HOOK_TIMEOUT_MS = 300_000;
const WORKSPACES = 20_000;
const CREATORS = 2_000;

let db: TestDatabase;
let accountId: string;

beforeAll(async () => {
  db = await createTestDatabase();
  accountId = freshId();
  await seedAccount(db, { id: accountId, email: "workspace-creator-plan@example.test", passwordHash: "$argon2id$stub" });
  await asSystem(db, (tx) => tx`
    INSERT INTO accounts (id, email, display_name)
    SELECT ('00000000-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid, 'creator' || n || '@example.test', 'Creator ' || n
    FROM generate_series(1, ${CREATORS}) AS n`);
  await asSystem(db, (tx) => tx`
    INSERT INTO workspaces (id, name, created_by)
    SELECT gen_random_uuid(), 'Workspace ' || n, ('00000000-0000-7000-8000-' || lpad((1 + n % ${CREATORS}::int)::text, 12, '0'))::uuid
    FROM generate_series(1, ${WORKSPACES}) AS n`);
  await asSystem(db, (tx) => tx`INSERT INTO workspaces (id, name) SELECT gen_random_uuid(), 'Orphan ' || n FROM generate_series(1, 60) AS n`);
  await asSystem(db, (tx) => tx`INSERT INTO workspaces (id, name, created_by) SELECT gen_random_uuid(), 'Mine ' || n, ${accountId}::uuid FROM generate_series(1, 20) AS n`);
  // The account owns 5 of its own workspaces and 15 others' among a larger set of memberships, so the lock reads both halves.
  await asSystem(db, (tx) => tx`
    INSERT INTO workspace_members (workspace_id, account_id, role)
    SELECT w.id, ${accountId}::uuid, 'owner' FROM (SELECT id FROM workspaces WHERE created_by = ${accountId}::uuid LIMIT 5) w`);
  await asSystem(db, (tx) => tx`
    INSERT INTO workspace_members (workspace_id, account_id, role)
    SELECT w.id, ('00000000-0000-7000-8000-' || lpad((1 + row_number() OVER () % ${CREATORS}::int)::text, 12, '0'))::uuid, 'owner'
    FROM (SELECT id FROM workspaces WHERE created_by IS NOT NULL AND created_by <> ${accountId}::uuid LIMIT 5000) w`);
  await asSystem(db, (tx) => tx`
    INSERT INTO workspace_members (workspace_id, account_id, role)
    SELECT w.id, ${accountId}::uuid, 'owner'
    FROM (SELECT id FROM workspaces WHERE created_by IS NOT NULL AND created_by <> ${accountId}::uuid ORDER BY id DESC LIMIT 15) w
    ON CONFLICT DO NOTHING`);
  await db.owner.unsafe("VACUUM (ANALYZE) workspaces");
  await db.owner.unsafe("VACUUM (ANALYZE) workspace_members");
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await db.drop();
}, HOOK_TIMEOUT_MS);

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Sort Key"?: string[];
  "Scan Direction"?: string;
  Alias?: string;
  Plans?: PlanNode[];
}

function nodesOf(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(nodesOf)];
}

let prepared = 0;

async function planRootOf(sql: string, mode: "force_custom_plan" | "force_generic_plan"): Promise<PlanNode> {
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
  return plan;
}

async function planOf(sql: string, mode: "force_custom_plan" | "force_generic_plan"): Promise<PlanNode[]> {
  return nodesOf(await planRootOf(sql, mode));
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

  // The locks the verification strip and the two account deletions take on the workspaces an account created or belongs to before they change anything, read
  // from the functions as the database holds them (210-email-verification.sql, 410-instance-recovery.sql, 290-account-deletion.sql,
  // 420-instance-account-deletion.sql): the first statement of each that locks workspaces, as a SELECT of the account in $1. Each half of the set must be read
  // through an index and the workspaces then locked by identifier, so no statement reads the whole table of workspaces.
  const LOCK_OF: readonly { name: string; fn: string; account: string; mode: string }[] = [
    { name: "account_strip_workspaces", fn: "account_strip_workspaces", account: "p_account_id", mode: "FOR NO KEY UPDATE OF w" },
    { name: "sys_email_verify", fn: "sys_email_verify", account: "v_token_account", mode: "FOR NO KEY UPDATE OF w" },
    { name: "sys_instance_update_account", fn: "sys_instance_update_account", account: "p_account_id", mode: "FOR NO KEY UPDATE OF w" },
    { name: "sys_account_deletion_scope", fn: "sys_account_deletion_scope", account: "p_account_id", mode: "FOR UPDATE OF w" },
    { name: "sys_instance_account_deletion_scope", fn: "sys_instance_account_deletion_scope", account: "p_account_id", mode: "FOR UPDATE OF w" },
  ];
  const DELETIONS = LOCK_OF.filter((lock) => lock.mode === "FOR UPDATE OF w").map((lock) => lock.name);
  const LOCKS: { name: string; sql: string }[] = [];

  beforeAll(async () => {
    for (const { name, fn, account, mode } of LOCK_OF) {
      const rows = await db.owner<{ source: string }[]>`SELECT prosrc AS source FROM pg_proc WHERE proname = ${fn} AND pronamespace = 'public'::regnamespace`;
      const statements = rows.flatMap((row) => new RegExp(`PERFORM 1 FROM public\\.workspaces w[\\s\\S]*?${mode};`).exec(row.source)?.[0] ?? []);
      expect(statements, `${fn} locks workspaces once`).toHaveLength(1);
      const [statement] = statements;
      if (statement === undefined) {
        throw new Error(`${fn} holds no lock of workspaces`);
      }
      LOCKS.push({ name: `the lock of ${name}`, sql: statement.replace("PERFORM 1 FROM", "SELECT 1 FROM").replace(/;$/, "").replaceAll(new RegExp(`\\b${account}\\b`, "g"), "$$1") });
    }
  });

  for (const [at, { name }] of LOCK_OF.entries()) {
    for (const mode of ["force_custom_plan", "force_generic_plan"] as const) {
      it(`plans the lock of ${name} with no sequential scan of workspaces, reading workspaces_created_by_idx (${mode})`, async () => {
        const nodes = await planOf(LOCKS[at]?.sql ?? "", mode);

        expect(nodes.filter((node) => node["Node Type"] === "Seq Scan" && node["Relation Name"] === "workspaces")).toEqual([]);
        expect(nodes.map((node) => node["Index Name"])).toContain("workspaces_created_by_idx");
      });
    }
  }

  // The two account deletions lock in identifier order (doc 05 section 7.1): LockRows takes its rows in the order its input delivers them. A nested loop and a
  // unique pass on the order of their outer input, so following the outer inputs down from LockRows must reach the node that fixes the order: a sort by the
  // identifier of a workspace (the join makes the identifiers of the two relations one), ascending, or a read of the primary key of workspaces in order.
  const ORDER_KEPT = new Set(["Nested Loop", "Merge Join", "Subquery Scan", "Unique"]);
  const orderOf = (root: PlanNode): string => {
    if (root["Node Type"] !== "LockRows") {
      return `the root is ${root["Node Type"]}`;
    }
    let node: PlanNode | undefined = root.Plans?.[0];
    while (node !== undefined && ORDER_KEPT.has(node["Node Type"])) {
      node = node.Plans?.[0];
    }
    if (node?.["Node Type"] === "Sort" && node["Sort Key"]?.length === 1 && /^[wc]\.id$/.test(node["Sort Key"][0] ?? "")) {
      return "identifier";
    }
    if (node?.["Node Type"] === "Index Scan" && node["Index Name"] === "workspaces_pkey" && node["Scan Direction"] === "Forward" && node.Alias === "w") {
      return "identifier";
    }
    return `${node?.["Node Type"] ?? "nothing"} on ${JSON.stringify(node?.["Sort Key"] ?? node?.["Index Name"])}`;
  };

  for (const name of DELETIONS) {
    for (const mode of ["force_custom_plan", "force_generic_plan"] as const) {
      it(`delivers the rows of the lock of ${name} to LockRows in the order of the workspace identifier (${mode})`, async () => {
        const lock = LOCKS[LOCK_OF.findIndex((candidate) => candidate.name === name)];

        expect(orderOf(await planRootOf(lock?.sql ?? "", mode))).toBe("identifier");
      });
    }
  }

  // The set a deletion locks is the set the statement it replaced matched, compared as lists of identifiers in lock order, on an account that holds a workspace
  // it created and belongs to, one it created and left, one it only belongs to as an owner, an admin and a member, one it created that is being deleted, one it
  // belongs to that is being deleted, workspaces whose creator is gone that it belongs to, and workspaces that are none of those (and one it did not create
  // that another account owns).
  it("locks exactly the workspaces the account created or belongs to that are not being deleted, the set the statement it replaced matched", async () => {
    const subject = freshId();
    const other = freshId();
    await seedAccount(db, { id: subject, email: "workspace-deletion-lock-subject@example.test", passwordHash: "$argon2id$stub" });
    await seedAccount(db, { id: other, email: "workspace-deletion-lock-other@example.test", passwordHash: "$argon2id$stub" });
    const made = async (name: string, creator: string | null, deleting: boolean): Promise<string> => {
      const id = freshId();
      await asSystem(db, (tx) => tx`INSERT INTO workspaces (id, name, created_by, deleting_at) VALUES (${id}::uuid, ${name}, ${creator}::uuid, ${deleting ? new Date() : null})`);
      return id;
    };
    const member = async (workspace: string, account: string, role: "owner" | "admin" | "member"): Promise<void> => {
      await asSystem(db, (tx) => tx`INSERT INTO workspace_members (workspace_id, account_id, role) VALUES (${workspace}::uuid, ${account}::uuid, ${role})`);
    };
    const createdAndOwned = await made("Eq created and owned", subject, false);
    await member(createdAndOwned, subject, "owner");
    const createdAndLeft = await made("Eq created and left", subject, false);
    await member(createdAndLeft, other, "owner");
    const ownedOnly = await made("Eq owned only", other, false);
    await member(ownedOnly, subject, "owner");
    const adminOnly = await made("Eq admin only", other, false);
    await member(adminOnly, subject, "admin");
    const memberOnly = await made("Eq member only", null, false);
    await member(memberOnly, subject, "member");
    const orphanOwned = await made("Eq orphan owned", null, false);
    await member(orphanOwned, subject, "owner");
    const createdDeleting = await made("Eq created deleting", subject, true);
    await member(createdDeleting, subject, "owner");
    const memberDeleting = await made("Eq member deleting", other, true);
    await member(memberDeleting, subject, "member");
    const othersOwn = await made("Eq others own", other, false);
    await member(othersOwn, other, "owner");
    const orphanOthers = await made("Eq orphan others", null, false);
    await member(orphanOthers, other, "owner");

    const id = `'${subject}'::uuid`;
    const expected = [createdAndOwned, createdAndLeft, ownedOnly, adminOnly, memberOnly, orphanOwned].sort();
    for (const name of DELETIONS) {
      const lock = LOCKS[LOCK_OF.findIndex((candidate) => candidate.name === name)];
      const [row] = await asSystem(db, (tx) => tx.unsafe<{ locked: string[]; before: string[] }[]>(`
        SELECT (SELECT array_agg(l.id) FROM (${(lock?.sql ?? "").replaceAll("$1", id).replace("SELECT 1 FROM", "SELECT w.id FROM")}) l) AS locked,
               (SELECT array_agg(o.id ORDER BY o.id) FROM (SELECT w.id FROM public.workspaces w WHERE w.deleting_at IS NULL
                 AND (w.created_by = ${id} OR w.id IN (SELECT m.workspace_id FROM public.workspace_members m WHERE m.account_id = ${id}))
                 ORDER BY w.id) o) AS before`));
      expect(row?.locked, name).toEqual(row?.before);
      expect(row?.locked, name).toEqual(expected);
    }
  });

  it("locks exactly the workspaces the account created and owns that are not being deleted, the set the statement it replaced matched", async () => {
    const id = `'${accountId}'::uuid`;
    const [row] = await asSystem(db, (tx) => tx.unsafe<{ locked: string; expected: string }[]>(`
      SELECT (SELECT count(*) FROM (${(LOCKS[0]?.sql ?? "").replaceAll("$1", id)}) l)::text AS locked,
             (SELECT count(*) FROM public.workspaces w WHERE w.deleting_at IS NULL
               AND (w.created_by = ${id} OR w.id IN (SELECT m.workspace_id FROM public.workspace_members m WHERE m.account_id = ${id} AND m.role = 'owner')))::text AS expected`));
    expect(row?.locked).toBe(row?.expected);
    expect(Number(row?.expected)).toBe(35);
  });

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
