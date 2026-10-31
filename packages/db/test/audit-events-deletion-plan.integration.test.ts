import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";

// The plan of the account deletion's lookups on a large event table (doc 05 sections 2.9 and 7.1): 155 160 events, none of them in a workspace. 150 000 are
// made by 25 other accounts, with 2 000 entities and, for one in 50 each, a `transferTo` or a `targetId` that names another account; 5 000 are made by the
// deployment with no actor; and 160 trace one account to delete, 40 each as the actor, as the entity, in `transferTo` and in `targetId`. Every statement of
// `account_delete` that reads the table by an account, and the lookup of the foreign-key action of `actor_account_id`, is planned with a custom and with a
// generic plan, and none reads the table sequentially: each is served by an index of audit_events that leads with the account. The failure scenario is a
// deletion that scans every event of the table while it holds the account's workspace locks.

const HOOK_TIMEOUT_MS = 300_000;
const EVENTS = 150_000;
const INSTANCE_EVENTS = 5_000;
const ACTORS = 25;
const ENTITIES = 2_000;
const TRACES = 40;
const TOTAL = EVENTS + INSTANCE_EVENTS + 4 * TRACES;

let db: TestDatabase;
let accountId: string;

beforeAll(async () => {
  db = await createTestDatabase();
  accountId = freshId();
  await seedAccount(db, { id: accountId, email: "audit-deletion-plan@example.test", passwordHash: "$argon2id$stub" });
  for (let n = 1; n <= ACTORS; n += 1) {
    await seedAccount(db, { id: `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`, email: `actor${String(n)}@example.test`, passwordHash: "$argon2id$stub" });
  }
  // Events of other accounts: an actor, a network, an entity and, for one in 50, a `transferTo` or a `targetId` that names another account.
  await asSystem(db, (tx) => tx`
    INSERT INTO audit_events (id, workspace_id, actor_type, actor_account_id, actor_label, action, entity_type, entity_id, metadata, ip_prefix, created_at)
    SELECT gen_random_uuid(), NULL, 'account', ('00000000-0000-7000-8000-' || lpad((1 + n % ${ACTORS}::int)::text, 12, '0'))::uuid, 'Actor',
           (ARRAY['workspace.renamed', 'member.role_changed', 'share.granted', 'member.removed'])[1 + n % 4],
           (ARRAY['workspace', 'member', 'bookmark'])[1 + n % 3],
           ('20000000-0000-7000-8000-' || lpad((n % ${ENTITIES}::int)::text, 12, '0'))::uuid,
           CASE WHEN n % 50 = 1 THEN jsonb_build_object('transferTo', '00000000-0000-7000-8000-' || lpad((1 + n % ${ACTORS}::int)::text, 12, '0'))
                WHEN n % 50 = 2 THEN jsonb_build_object('targetId', '00000000-0000-7000-8000-' || lpad((1 + n % ${ACTORS}::int)::text, 12, '0'))
                ELSE '{}'::jsonb END,
           '10.1.2.0/24', now() - n * interval '3 minutes'
    FROM generate_series(1, ${EVENTS}) AS n`);
  await asSystem(db, (tx) => tx`
    INSERT INTO audit_events (id, workspace_id, actor_type, actor_label, action, metadata, created_at)
    SELECT gen_random_uuid(), NULL, 'system', 'SlugBase', 'workspace.renamed', '{}'::jsonb, now() - n * interval '5 minutes'
    FROM generate_series(1, ${INSTANCE_EVENTS}) AS n`);
  // The traces of the account to delete, in upper case for the metadata fields, which the deletion compares in lower case.
  await asSystem(db, (tx) => tx`
    INSERT INTO audit_events (id, workspace_id, actor_type, actor_account_id, actor_label, action, entity_type, entity_id, metadata, ip_prefix)
    SELECT gen_random_uuid(), NULL, 'account', ${accountId}::uuid, 'Victim', 'member.role_changed', 'member', NULL, '{}'::jsonb, '10.9.9.0/24'
    FROM generate_series(1, ${TRACES}) AS n`);
  await asSystem(db, (tx) => tx`
    INSERT INTO audit_events (id, workspace_id, actor_type, actor_label, action, entity_type, entity_id, metadata)
    SELECT gen_random_uuid(), NULL, 'system', 'SlugBase', 'member.removed', 'member', ${accountId}::uuid, '{}'::jsonb
    FROM generate_series(1, ${TRACES}) AS n`);
  await asSystem(db, (tx) => tx`
    INSERT INTO audit_events (id, workspace_id, actor_type, actor_label, action, metadata)
    SELECT gen_random_uuid(), NULL, 'system', 'SlugBase', 'member.role_changed', jsonb_build_object('transferTo', upper(${accountId}::text))
    FROM generate_series(1, ${TRACES}) AS n`);
  await asSystem(db, (tx) => tx`
    INSERT INTO audit_events (id, workspace_id, actor_type, actor_label, action, metadata)
    SELECT gen_random_uuid(), NULL, 'system', 'SlugBase', 'share.granted', jsonb_build_object('targetId', ${accountId}::text)
    FROM generate_series(1, ${TRACES}) AS n`);
  await db.owner.unsafe("VACUUM (ANALYZE) audit_events");
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

// The statements of `account_delete` (src/sql/290-account-deletion.sql) that read audit_events by the account, with the parameter they take, and the update the
// foreign key of `actor_account_id` runs on the delete of the account (ON DELETE SET NULL): the same condition on the same table, read as a SELECT because
// slugbase_system holds no UPDATE of that column and the action runs as the owner of the table.
const STATEMENTS: readonly { name: string; index: string; sql: string; param: "uuid" | "text" }[] = [
  {
    name: "the network of the events the account made",
    index: "audit_events_actor_account_id_idx",
    sql: "UPDATE public.audit_events SET ip_prefix = NULL WHERE actor_account_id = $1 AND ip_prefix IS NOT NULL",
    param: "uuid",
  },
  {
    name: "the foreign-key action on actor_account_id",
    index: "audit_events_actor_account_id_idx",
    sql: "SELECT ctid FROM ONLY public.audit_events WHERE $1 OPERATOR(pg_catalog.=) actor_account_id",
    param: "uuid",
  },
  {
    name: "the entity that names the account",
    index: "audit_events_entity_id_idx",
    sql: "UPDATE public.audit_events SET entity_id = NULL WHERE entity_id = $1",
    param: "uuid",
  },
  {
    name: "the transferTo field that names the account",
    index: "audit_events_transfer_to_idx",
    sql: "UPDATE public.audit_events SET metadata = metadata - 'transferTo' WHERE lower(metadata ->> 'transferTo') = $1",
    param: "text",
  },
  {
    name: "the targetId field that names the account",
    index: "audit_events_target_id_idx",
    sql: "UPDATE public.audit_events SET metadata = metadata - 'targetId' WHERE lower(metadata ->> 'targetId') = $1",
    param: "text",
  },
];

let prepared = 0;

/** The nodes of the plan of `statement` as slugbase_system plans it, once with a plan made for the value and once with a generic one; EXPLAIN runs nothing. */
async function planOf(statement: (typeof STATEMENTS)[number], mode: "force_custom_plan" | "force_generic_plan"): Promise<PlanNode[]> {
  prepared += 1;
  const name = `deletion_lookup_${String(prepared)}`;
  const explain = async (tx: postgres.TransactionSql): Promise<PlanNode | undefined> => {
    await tx.unsafe(`SET LOCAL plan_cache_mode = ${mode}`);
    await tx.unsafe(`PREPARE ${name} (${statement.param}) AS ${statement.sql}`);
    const rows = await tx.unsafe<{ "QUERY PLAN": { Plan: PlanNode }[] }[]>(`EXPLAIN (FORMAT JSON) EXECUTE ${name}('${accountId}')`);
    return rows[0]?.["QUERY PLAN"][0]?.Plan;
  };
  const plan = await asSystem(db, explain);
  if (plan === undefined) {
    throw new Error("EXPLAIN returned no plan");
  }
  return nodesOf(plan);
}

describe(`the account deletion's lookups on a table of ${String(TOTAL)} events`, () => {
  it("holds the events the plans are made for", async () => {
    const [row] = await asSystem(db, (tx) => tx<{ total: string }[]>`SELECT count(*)::text AS total FROM audit_events`);
    expect(row?.total).toBe(String(TOTAL));
  });

  for (const statement of STATEMENTS) {
    for (const mode of ["force_custom_plan", "force_generic_plan"] as const) {
      it(`plans ${statement.name} from ${statement.index} with no sequential scan (${mode})`, async () => {
        const nodes = await planOf(statement, mode);

        expect(nodes.filter((node) => node["Node Type"] === "Seq Scan")).toEqual([]);
        expect(nodes.map((node) => node["Index Name"]).filter((name) => name !== undefined)).toContain(statement.index);
      });
    }
  }

  it("reads each of the four indexes when the account is deleted, and the deletion clears every trace of the account", async () => {
    const names = STATEMENTS.map((statement) => statement.index).filter((name, at, all) => all.indexOf(name) === at);
    const scans = async (): Promise<Record<string, number>> => {
      const rows = await db.owner<{ name: string; scans: string }[]>`
        SELECT indexrelname AS name, idx_scan::text AS scans FROM pg_stat_user_indexes WHERE relname = 'audit_events' AND indexrelname = ANY (${names})`;
      return Object.fromEntries(rows.map((row) => [row.name, Number(row.scans)]));
    };
    const before = await scans();
    expect(Object.keys(before).sort()).toEqual([...names].sort());

    await asSystem(db, async (tx) => {
      await tx`SELECT pg_stat_force_next_flush()`;
      await tx`SELECT account_delete(${accountId}::uuid, '{}'::uuid[])`;
    });

    const after = await scans();
    for (const name of names) {
      expect(after[name], name).toBeGreaterThan(before[name] ?? 0);
    }
    const [left] = await asSystem(db, (tx) => tx<{ actor: string; entity: string; network: string; transfer: string; target: string }[]>`
      SELECT count(*) FILTER (WHERE actor_label = 'Victim' AND actor_account_id IS NOT NULL)::text AS actor,
             count(*) FILTER (WHERE entity_id = ${accountId}::uuid)::text AS entity,
             count(*) FILTER (WHERE actor_label = 'Victim' AND ip_prefix IS NOT NULL)::text AS network,
             count(*) FILTER (WHERE lower(metadata ->> 'transferTo') = ${accountId})::text AS transfer,
             count(*) FILTER (WHERE lower(metadata ->> 'targetId') = ${accountId})::text AS target
      FROM audit_events`);
    expect(left).toEqual({ actor: "0", entity: "0", network: "0", transfer: "0", target: "0" });
  });

  it("reads the index on the actor when the foreign key of an account's events is followed on the delete of the account", async () => {
    const actor = freshId();
    await seedAccount(db, { id: actor, email: "audit-deletion-actor@example.test", passwordHash: "$argon2id$stub" });
    await asSystem(db, (tx) => tx`
      INSERT INTO audit_events (id, workspace_id, actor_type, actor_account_id, actor_label, action)
      SELECT gen_random_uuid(), NULL, 'account', ${actor}::uuid, 'Former', 'member.removed' FROM generate_series(1, ${TRACES}) AS n`);
    const scans = async (): Promise<number> => {
      const [row] = await db.owner<{ scans: string }[]>`
        SELECT idx_scan::text AS scans FROM pg_stat_user_indexes WHERE relname = 'audit_events' AND indexrelname = 'audit_events_actor_account_id_idx'`;
      return Number(row?.scans);
    };
    const before = await scans();

    await asSystem(db, async (tx) => {
      await tx`SELECT pg_stat_force_next_flush()`;
      await tx`DELETE FROM accounts WHERE id = ${actor}::uuid`;
    });

    expect(await scans()).toBeGreaterThan(before);
    const [row] = await asSystem(db, (tx) => tx<{ kept: string; named: string }[]>`
      SELECT count(*) FILTER (WHERE actor_label = 'Former')::text AS kept, count(*) FILTER (WHERE actor_account_id = ${actor}::uuid)::text AS named FROM audit_events`);
    expect(row).toEqual({ kept: String(TRACES), named: "0" });
  });
});
