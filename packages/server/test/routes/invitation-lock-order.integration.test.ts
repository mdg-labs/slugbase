import { hashCredentialToken, type MailPort } from "@slugbase/core";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EntitlementCheck } from "../../src/http/authorize.ts";
import { HOOK_TIMEOUT_MS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// DELETE /api/v1/invitations/{id}, POST /api/v1/invitations/{id}/resend, POST /api/v1/invitations/{id}/link and
// POST /api/v1/invitations/accept racing each other through the whole chain over the migrated database (doc 04
// section 10.5, doc 02 section 3.4, doc 05 section 3.3). The failure scenario: an admin revokes (resends, gives a link
// to) a pending invitation at the moment the invitee accepts it; the accept holds the workspace row and waits for the
// invitation row the admin's request holds, and the admin's audit event waits for the workspace row, so the database
// aborts one of the two with a deadlock error and the request answers 500.
//
// The management request is held between its write to the invitation and its audit event by a lock on the audit table
// that its insert waits for, before any foreign key is checked; the accept is sent while it waits.

const INVITATIONS = "/api/v1/invitations";
const ACCEPT = `${INVITATIONS}/accept`;
const TEST_TIMEOUT_MS = 60_000;
const BLOCKED_DEADLINE_MS = 20_000;
const POLL_MS = 25;
const PASSWORD = "correct horse battery staple 42";

const database = useTestDatabase();
const harness = workspaceHarness(database);
const GRANTED: EntitlementCheck = (entitlement) => entitlement === "members.invite";

beforeAll(() => harness.start(), HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await database().owner`TRUNCATE pgboss.job`;
});

afterAll(() => harness.stop());

/** How many backends of this database wait for a lock. */
async function backendsWaitingForLock(): Promise<number> {
  const rows = await database().owner<{ waiting: string }[]>`
    SELECT count(DISTINCT l.pid)::text AS waiting
    FROM pg_locks l JOIN pg_stat_activity s ON s.pid = l.pid
    WHERE NOT l.granted AND s.datname = current_database()`;
  return Number(rows[0]?.waiting ?? 0);
}

async function waitUntilWaiting(backends: number, what: string): Promise<void> {
  const deadline = Date.now() + BLOCKED_DEADLINE_MS;
  while ((await backendsWaitingForLock()) < backends) {
    if (Date.now() > deadline) {
      throw new Error(`${what} never waited for a lock`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/** A mail port that can mail, which a resend needs; nothing is sent, since no worker runs. */
const mail: MailPort = { available: true, send: () => Promise.resolve() };

function serve(): World {
  return harness.serve({ entitlements: GRANTED, mail, env: { RATE_LIMIT_TOKEN_REDEEM_IP: "10000/hour", RATE_LIMIT_TOKEN_REDEEM_ACCOUNT: "10000/hour" } });
}

interface Pending {
  readonly workspaceId: string;
  readonly admin: Person;
  readonly invitationId: string;
  readonly token: string;
  readonly email: string;
}

/** A workspace of an owner and an admin, and a pending invitation of `email` whose link the admin has copied. */
async function pending(world: World, email: string): Promise<Pending> {
  const owner = await harness.person(world);
  const admin = await harness.person(world);
  const { workspaceId } = await harness.workspaceOf([
    { person: owner, role: "owner" },
    { person: admin, role: "admin" },
  ]);
  const created = await send(world, "POST", INVITATIONS, { cookie: admin.cookie }, { email, role: "member" });
  expect(created.status).toBe(201);
  const { id } = (await created.json()) as { id: string };
  const linked = await send(world, "POST", `${INVITATIONS}/${id}/link`, { cookie: admin.cookie });
  expect(linked.status).toBe(200);
  const { link } = (await linked.json()) as { link: string };
  const token = new URL(link).pathname.split("/").at(-1);
  if (token === undefined || hashCredentialToken(token) === undefined) {
    throw new Error("the link carries no token");
  }
  return { workspaceId, admin, invitationId: id, token, email };
}

/**
 * Locks the audit table against inserts while `first` is sent and waits for a lock, then sends `second`, which waits
 * for a lock as well, and releases the table; answers both responses. The request that writes an audit event waits at
 * its insert, with the rows it has changed locked and no foreign key of the event checked yet.
 */
async function raceBehindAuditInsert(first: () => Promise<Response>, second: () => Promise<Response>): Promise<readonly [Response, Response]> {
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held: () => void = () => undefined;
  const tableHeld = new Promise<void>((resolve) => {
    held = resolve;
  });
  const holding = database().owner.begin(async (tx) => {
    await tx`LOCK TABLE public.audit_events IN SHARE MODE`;
    held();
    await released;
  });
  await tableHeld;
  const requests: Promise<Response>[] = [];
  try {
    requests.push(first());
    await waitUntilWaiting(1, "the first request");
    requests.push(second());
    await waitUntilWaiting(2, "the second request");
  } finally {
    release();
  }
  await holding;
  const [one, two] = await Promise.all(requests);
  if (one === undefined || two === undefined) {
    throw new Error("a request was not sent");
  }
  return [one, two];
}

async function invitationStatus(id: string): Promise<string | undefined> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ status: string }[]>`SELECT status FROM workspace_invitations WHERE id = ${id}`;
  });
  return rows[0]?.status;
}

async function membersWithEmail(workspaceId: string, email: string): Promise<number> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ members: string }[]>`
      SELECT count(*)::text AS members FROM workspace_members m JOIN accounts a ON a.id = m.account_id
      WHERE m.workspace_id = ${workspaceId} AND a.email = ${email}`;
  });
  return Number(rows[0]?.members ?? 0);
}

const MANAGEMENTS: readonly {
  readonly name: string;
  readonly request: (world: World, admin: Person, id: string) => Promise<Response>;
  readonly status: number;
  readonly settled: "pending" | "revoked";
  readonly audit: string;
}[] = [
  { name: "DELETE /invitations/{id}", request: (world, admin, id) => send(world, "DELETE", `${INVITATIONS}/${id}`, { cookie: admin.cookie }), status: 204, settled: "revoked", audit: "invitation.revoked" },
  { name: "POST /invitations/{id}/resend", request: (world, admin, id) => send(world, "POST", `${INVITATIONS}/${id}/resend`, { cookie: admin.cookie }), status: 200, settled: "pending", audit: "invitation.resent" },
  { name: "POST /invitations/{id}/link", request: (world, admin, id) => send(world, "POST", `${INVITATIONS}/${id}/link`, { cookie: admin.cookie }), status: 200, settled: "pending", audit: "invitation.link_created" },
];

describe.each(MANAGEMENTS)("$name against POST /invitations/accept", { timeout: TEST_TIMEOUT_MS }, (management) => {
  it("answers the management request, and refuses the accept with 410, when the accept arrives while the request waits for its audit event", async () => {
    const world = serve();
    const invitee = await harness.person(world);
    const scenario = await pending(world, invitee.account.email);
    const before = await harness.auditActions(scenario.workspaceId);

    const [managed, accepted] = await raceBehindAuditInsert(
      () => management.request(world, scenario.admin, scenario.invitationId),
      () => send(world, "POST", ACCEPT, { cookie: invitee.cookie }, { token: scenario.token }),
    );

    expect(managed.status).toBe(management.status);
    expect(accepted.status).toBe(410);
    expect(await invitationStatus(scenario.invitationId)).toBe(management.settled);
    expect(await membersWithEmail(scenario.workspaceId, scenario.email)).toBe(0);
    expect((await harness.auditActions(scenario.workspaceId)).slice(before.length)).toEqual([management.audit]);
  });
});

describe("DELETE /invitations/{id} against a sign-up through the link", { timeout: TEST_TIMEOUT_MS }, () => {
  it("answers 204 for the revocation and 410 for the sign-up, and creates no account", async () => {
    const world = serve();
    const email = `signup-race-${Date.now().toString(36)}@example.test`;
    const scenario = await pending(world, email);

    const [revoked, signedUp] = await raceBehindAuditInsert(
      () => send(world, "DELETE", `${INVITATIONS}/${scenario.invitationId}`, { cookie: scenario.admin.cookie }),
      () => send(world, "POST", ACCEPT, {}, { token: scenario.token, displayName: "Grace Hopper", password: PASSWORD }),
    );

    expect(revoked.status).toBe(204);
    expect(signedUp.status).toBe(410);
    expect(await invitationStatus(scenario.invitationId)).toBe("revoked");
    const accounts = await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      return tx`SELECT 1 FROM accounts WHERE email = ${email}`;
    });
    expect(accounts).toHaveLength(0);
  });
});
