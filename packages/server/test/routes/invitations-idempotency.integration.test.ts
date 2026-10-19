import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { MailPort } from "@slugbase/core";
import { InMemoryMail } from "@slugbase/testing";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EntitlementCheck } from "../../src/http/authorize.ts";
import { seedMembership, setActiveWorkspace } from "../auth/support.ts";
import { HOOK_TIMEOUT_MS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// The Idempotency-Key of POST /api/v1/invitations through the whole chain over the migrated database (doc 04
// section 6.3, doc 05 section 2.10, doc 10 T1). The failure scenarios: two requests with one key that both
// run and so make two mails; a retry that is answered by running again or by a false conflict; one key
// replayed against another request, another workspace or another account; a replay that skips the
// authorization of the request; a refused request that leaves its key behind; and a key that outlives its
// 24 hours.

const INVITATIONS = "/api/v1/invitations";
const KEY_HEADER = "idempotency-key";
const REPLAYED_HEADER = "idempotency-replayed";
const WAIT_MS = 20_000;
const TEST_TIMEOUT_MS = 60_000;

const database = useTestDatabase();
const harness = workspaceHarness(database);
const inbox = new InMemoryMail();
const mail: MailPort = { available: true, send: (message) => inbox.send(message) };
const GRANTED: EntitlementCheck = (entitlement) => entitlement === "members.invite";

beforeAll(() => harness.start(), HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await database().owner`TRUNCATE pgboss.job`;
});

afterAll(() => harness.stop());

function invite(world: World, person: Person, body: unknown, key?: string): Promise<Response> {
  return send(world, "POST", INVITATIONS, { cookie: person.cookie, ...(key === undefined ? {} : { [KEY_HEADER]: key }) }, body);
}

async function invitationCount(workspaceId: string): Promise<number> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ count: number }[]>`SELECT count(*)::int AS count FROM workspace_invitations WHERE workspace_id = ${workspaceId}`;
  });
  return rows[0]?.count ?? -1;
}

async function auditActions(workspaceId: string): Promise<string[]> {
  return harness.auditActions(workspaceId);
}

async function jobCount(workspaceId: string): Promise<number> {
  const rows = await database().app<{ count: number }[]>`SELECT count(*)::int AS count FROM pgboss.job WHERE name = 'invitation.send' AND data->>'workspaceId' = ${workspaceId}`;
  return rows[0]?.count ?? -1;
}

interface KeyRow {
  readonly account_id: string;
  readonly operation: string;
  readonly status: string;
  readonly response_status: number | null;
}

async function keysOf(key: string): Promise<KeyRow[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<KeyRow[]>`SELECT account_id, operation, status, response_status FROM idempotency_keys WHERE key = ${key} ORDER BY account_id`;
  });
  return [...rows];
}

async function problemCode(response: Response): Promise<string> {
  return ((await response.json()) as { code: string }).code;
}

async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(50);
  }
}

/** How many backends wait for a lock on a table of this database. */
async function tableWaiters(): Promise<number> {
  const rows = await database().owner<{ count: number }[]>`
    SELECT count(*)::int AS count FROM pg_locks
    WHERE NOT granted AND locktype = 'relation' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`;
  return rows[0]?.count ?? 0;
}

/** How many backends wait for a transaction that has locked something in this database to end: a request waiting on the key another holds. */
async function transactionWaiters(): Promise<number> {
  const rows = await database().owner<{ count: number }[]>`
    SELECT count(*)::int AS count
    FROM pg_locks waiting
    JOIN pg_locks holder ON holder.locktype = 'transactionid' AND holder.transactionid = waiting.transactionid AND holder.granted AND holder.pid <> waiting.pid
    WHERE waiting.locktype = 'transactionid' AND NOT waiting.granted
      AND EXISTS (
        SELECT 1 FROM pg_locks held
        WHERE held.pid = holder.pid AND held.locktype = 'relation' AND held.database = (SELECT oid FROM pg_database WHERE datname = current_database()))`;
  return rows[0]?.count ?? 0;
}

/** A workspace of an owner `o` and an admin `a`. */
async function workspace(world: World) {
  const o = await harness.person(world);
  const a = await harness.person(world);
  const { workspaceId } = await harness.workspaceOf([
    { person: o, role: "owner" },
    { person: a, role: "admin" },
  ]);
  return { workspaceId, o, a };
}

describe("POST /api/v1/invitations with an Idempotency-Key", { timeout: TEST_TIMEOUT_MS }, () => {
  it("makes one invitation and one mail job of two requests with one key that arrive at the same moment, answering both with the one response", async () => {
    const world = harness.serve({ entitlements: GRANTED, mail });
    const { workspaceId, a } = await workspace(world);
    const key = randomUUID();
    const body = { email: "race@example.test", role: "member" };

    // A lock on the table holds the first request inside its transaction, key claimed, until the second has
    // arrived at the key, so the two overlap whatever the speed of the machine.
    const lock = await database().owner.reserve();
    let first: Promise<Response>;
    let second: Promise<Response>;
    try {
      await lock`BEGIN`;
      await lock`LOCK TABLE workspace_invitations IN SHARE ROW EXCLUSIVE MODE`;
      first = invite(world, a, body, key);
      await until(async () => (await tableWaiters()) >= 1, "the first request to wait on the table");
      second = invite(world, a, body, key);
      await until(async () => (await transactionWaiters()) >= 1, "the second request to wait on the key");
      await lock`COMMIT`;
    } finally {
      lock.release();
    }
    const responses = await Promise.all([first, second]);

    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    expect(responses.map((response) => response.headers.get(REPLAYED_HEADER)).sort()).toEqual([null, "true"]);
    const bodies = await Promise.all(responses.map((response) => response.json() as Promise<Record<string, unknown>>));
    expect(bodies[1]).toEqual(bodies[0]);
    expect(await invitationCount(workspaceId)).toBe(1);
    expect(await jobCount(workspaceId)).toBe(1);
    expect(await auditActions(workspaceId)).toEqual(["invitation.created"]);
    expect((await keysOf(key)).map((row) => [row.operation, row.status, row.response_status])).toEqual([["createInvitation", "done", 201]]);
  });

  it("answers a retry with the stored response and Idempotency-Replayed: true, and runs nothing again", async () => {
    const world = harness.serve({ entitlements: GRANTED, mail });
    const { workspaceId, o } = await workspace(world);
    const key = randomUUID();
    const body = { role: "admin", email: "grace@example.test" };

    const first = await invite(world, o, body, key);
    const retry = await invite(world, o, { email: "grace@example.test", role: "admin" }, key.toUpperCase());

    expect(first.status).toBe(201);
    expect(first.headers.get(REPLAYED_HEADER)).toBeNull();
    expect(retry.status).toBe(201);
    expect(retry.headers.get(REPLAYED_HEADER)).toBe("true");
    expect(retry.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await retry.json()).toEqual(await first.json());
    expect(await invitationCount(workspaceId)).toBe(1);
    expect(await jobCount(workspaceId)).toBe(1);
    expect(await auditActions(workspaceId)).toEqual(["invitation.created"]);
    expect(await keysOf(key)).toHaveLength(1);
  });

  it("runs every request again that carries no key: two requests are a creation and a resend", async () => {
    const world = harness.serve({ entitlements: GRANTED, mail });
    const { workspaceId, o } = await workspace(world);

    const first = await invite(world, o, { email: "grace@example.test", role: "member" });
    const second = await invite(world, o, { email: "grace@example.test", role: "member" });

    expect([first.status, second.status]).toEqual([201, 201]);
    expect(second.headers.get(REPLAYED_HEADER)).toBeNull();
    expect(await auditActions(workspaceId)).toEqual(["invitation.created", "invitation.resent"]);
    expect(await jobCount(workspaceId)).toBe(2);
  });

  it("answers 409 idempotency_conflict for the key of another request, and writes nothing for it", async () => {
    const world = harness.serve({ entitlements: GRANTED, mail });
    const { workspaceId, o } = await workspace(world);
    const key = randomUUID();
    await invite(world, o, { email: "grace@example.test", role: "member" }, key);

    const otherRole = await invite(world, o, { email: "grace@example.test", role: "admin" }, key);
    const otherAddress = await invite(world, o, { email: "linus@example.test", role: "member" }, key);
    const replay = await invite(world, o, { email: "grace@example.test", role: "member" }, key);

    expect(otherRole.status).toBe(409);
    expect(await problemCode(otherRole)).toBe("idempotency_conflict");
    expect(otherAddress.status).toBe(409);
    expect(replay.status).toBe(201);
    expect(replay.headers.get(REPLAYED_HEADER)).toBe("true");
    expect(await invitationCount(workspaceId)).toBe(1);
    expect(await jobCount(workspaceId)).toBe(1);
    expect(await auditActions(workspaceId)).toEqual(["invitation.created"]);
  });

  it("answers 409 idempotency_conflict for the key of the same request in another workspace of the account", async () => {
    const world = harness.serve({ entitlements: GRANTED, mail });
    const first = await workspace(world);
    const second = await workspace(world);
    // The admin of the first workspace is an admin of the second one too, and acts in whichever is active.
    await seedMembership(database(), { workspaceId: second.workspaceId, accountId: first.a.account.id, role: "admin" });
    const key = randomUUID();
    const body = { email: "grace@example.test", role: "member" };
    expect((await invite(world, first.a, body, key)).status).toBe(201);
    await setActiveWorkspace(database(), first.a.sessionId, second.workspaceId);

    const elsewhere = await invite(world, first.a, body, key);

    expect(elsewhere.status).toBe(409);
    expect(await problemCode(elsewhere)).toBe("idempotency_conflict");
    expect(await invitationCount(second.workspaceId)).toBe(0);
    expect(await invitationCount(first.workspaceId)).toBe(1);
  });

  it("keeps the keys of two accounts apart: the same UUID and request from another account makes its own invitation and never sees the other's response", async () => {
    const world = harness.serve({ entitlements: GRANTED, mail });
    const mine = await workspace(world);
    const theirs = await workspace(world);
    const key = randomUUID();
    const body = { email: "grace@example.test", role: "member" };

    const first = await invite(world, mine.o, body, key);
    const other = await invite(world, theirs.o, body, key);

    expect([first.status, other.status]).toEqual([201, 201]);
    expect(other.headers.get(REPLAYED_HEADER)).toBeNull();
    expect(((await other.json()) as { id: string }).id).not.toBe(((await first.json()) as { id: string }).id);
    expect(await invitationCount(mine.workspaceId)).toBe(1);
    expect(await invitationCount(theirs.workspaceId)).toBe(1);
    expect((await keysOf(key)).map((row) => row.account_id).sort()).toEqual([mine.o.account.id, theirs.o.account.id].sort());
  });

  it("judges a replay by the authorization of the retry: an admin who has become a member is refused, not answered the stored response", async () => {
    const world = harness.serve({ entitlements: GRANTED, mail });
    const { workspaceId, o, a } = await workspace(world);
    const key = randomUUID();
    const body = { email: "grace@example.test", role: "member" };
    expect((await invite(world, a, body, key)).status).toBe(201);
    await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      await tx`UPDATE workspace_members SET role = 'member' WHERE workspace_id = ${workspaceId} AND account_id = ${a.account.id}`;
    });

    const retry = await invite(world, a, body, key);

    expect(retry.status).toBe(403);
    expect(retry.headers.get(REPLAYED_HEADER)).toBeNull();
    expect(await problemCode(retry)).toBe("forbidden");
    expect((await invite(world, o, body, key)).status).toBe(201);
  });

  it("stores nothing for a request that is refused: the key is free for the retry, which runs", async () => {
    const world = harness.serve({ entitlements: GRANTED, mail });
    const { workspaceId, o, a } = await workspace(world);
    const key = randomUUID();

    const member = await invite(world, o, { email: a.account.email, role: "member" }, key);
    const teams = await invite(world, o, { email: "grace@example.test", role: "member", teamIds: [randomUUID()] }, key);

    expect(member.status).toBe(409);
    expect(await problemCode(member)).toBe("already_member");
    expect(teams.status).toBe(422);
    expect(await keysOf(key)).toEqual([]);
    expect(await invitationCount(workspaceId)).toBe(0);
    const retry = await invite(world, o, { email: "grace@example.test", role: "member" }, key);
    expect(retry.status).toBe(201);
    expect(retry.headers.get(REPLAYED_HEADER)).toBeNull();
  });

  it("refuses a key that is not a UUID, and several keys, with 400 bad_request and writes nothing", async () => {
    const world = harness.serve({ entitlements: GRANTED, mail });
    const { workspaceId, o } = await workspace(world);
    const body = { email: "grace@example.test", role: "member" };

    for (const key of ["", "not-a-uuid", `${randomUUID()}, ${randomUUID()}`, `${randomUUID()}x`]) {
      const response = await invite(world, o, body, key);
      expect(response.status).toBe(400);
      expect(await problemCode(response)).toBe("bad_request");
    }
    expect(await invitationCount(workspaceId)).toBe(0);
  });

  it("treats a key past its 24 hours as unused: the request runs again and is not a replay", async () => {
    const world = harness.serve({ entitlements: GRANTED, mail });
    const { workspaceId, o } = await workspace(world);
    const key = randomUUID();
    const body = { email: "grace@example.test", role: "member" };
    await invite(world, o, body, key);
    await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      await tx`UPDATE idempotency_keys SET expires_at = now() - interval '1 second' WHERE key = ${key}`;
    });

    const again = await invite(world, o, body, key);

    expect(again.status).toBe(201);
    expect(again.headers.get(REPLAYED_HEADER)).toBeNull();
    expect(await auditActions(workspaceId)).toEqual(["invitation.created", "invitation.resent"]);
    expect(await jobCount(workspaceId)).toBe(2);
    expect(await keysOf(key)).toHaveLength(1);
  });
});
