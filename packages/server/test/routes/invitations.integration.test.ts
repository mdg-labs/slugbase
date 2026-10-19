import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { hashCredentialToken, type MailPort } from "@slugbase/core";
import { InMemoryMail } from "@slugbase/testing";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/index.ts";
import type { EntitlementCheck } from "../../src/http/authorize.ts";
import { createWorker, type RunningWorker } from "../../src/worker/index.ts";
import { seedAccount, seedMembership, setActiveWorkspace } from "../auth/support.ts";
import { productionEnv } from "../config/support.ts";
import { appUrl, tenantDatabase } from "../contract/support.ts";
import { adapters, recordingLogger } from "../support.ts";
import { HOOK_TIMEOUT_MS, bearer, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// POST /api/v1/invitations through the whole chain over the migrated database, and the email it queues through
// the worker (doc 04 section 10.5, doc 02 section 3.4, doc 05 section 2.2, doc 10 T1, T3, T4 and T19). The failure
// scenarios: a token that is stored or queued or logged in the clear; an invitation for the owner role; a
// member, a token or an account of another workspace who invites; an invitation written for an address that
// belongs to a member; a resend that leaves two pending invitations or the earlier link working; an email
// for an invitation that was revoked, and one in the wrong language; an invitation that is half written when
// the request fails; and an operation that is reachable without the entitlement it declares.

const INVITATIONS = "/api/v1/invitations";
const POLL_SECONDS = 0.5;
const WAIT_MS = 20_000;
const TEST_TIMEOUT_MS = 60_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const database = useTestDatabase();
const harness = workspaceHarness(database);
const inbox = new InMemoryMail();
const mail: MailPort = { available: true, send: (message) => inbox.send(message) };
const GRANTED: EntitlementCheck = (entitlement) => entitlement === "members.invite";
let worker: RunningWorker | undefined;

beforeAll(() => harness.start(), HOOK_TIMEOUT_MS);

beforeEach(async () => {
  // A worker takes every job that is queued, so a test starts with none from the tests before it.
  await database().owner`TRUNCATE pgboss.job`;
});

afterEach(async () => {
  await worker?.shutdown();
  worker = undefined;
  inbox.clear();
});

afterAll(() => harness.stop());

interface InvitationRow {
  readonly id: string;
  readonly email: string;
  readonly role: string;
  readonly status: string;
  readonly invited_by: string | null;
  readonly team_ids: string[];
  readonly token_hash: Buffer;
  readonly expires_at: Date;
  readonly created_at: Date;
}

function rowsOf(workspaceId: string): Promise<InvitationRow[]> {
  return database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return [...(await tx<InvitationRow[]>`SELECT * FROM workspace_invitations WHERE workspace_id = ${workspaceId} ORDER BY created_at, id`)];
  });
}

interface JobRow {
  readonly id: string;
  readonly state: string;
  readonly data: Record<string, unknown>;
}

function jobsOf(workspaceId: string): Promise<JobRow[]> {
  return database().app<JobRow[]>`SELECT id, state, data FROM pgboss.job WHERE name = 'invitation.send' AND data->>'workspaceId' = ${workspaceId} ORDER BY created_on`.then((rows) => [...rows]);
}

async function checksum(workspaceId: string): Promise<string> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ digest: string }[]>`
      SELECT md5(
        coalesce((SELECT string_agg(i::text, '|' ORDER BY i.id) FROM workspace_invitations i WHERE i.workspace_id = ${workspaceId}), '') ||
        coalesce((SELECT string_agg(e::text, '|' ORDER BY e.id) FROM audit_events e WHERE e.workspace_id = ${workspaceId}), '')
      ) AS digest`;
  });
  return rows[0]?.digest ?? "";
}

async function setProfile(accountId: string, changes: { displayName?: string; locale?: "en" | "de" }): Promise<void> {
  await database().owner.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${accountId}, true)`;
    if (changes.displayName !== undefined) {
      await tx`UPDATE accounts SET display_name = ${changes.displayName} WHERE id = ${accountId}`;
    }
    if (changes.locale !== undefined) {
      await tx`UPDATE accounts SET locale = ${changes.locale} WHERE id = ${accountId}`;
    }
  });
}

async function auditOf(workspaceId: string): Promise<{ action: string; entity_type: string | null; entity_id: string | null; metadata: Record<string, unknown> }[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ action: string; entity_type: string | null; entity_id: string | null; metadata: Record<string, unknown> }[]>`
      SELECT action, entity_type, entity_id, metadata FROM audit_events WHERE workspace_id = ${workspaceId} ORDER BY created_at, id`;
  });
  return [...rows];
}

function invite(world: World, person: Person, body: unknown): Promise<Response> {
  return send(world, "POST", INVITATIONS, { cookie: person.cookie }, body);
}

async function problemOf(response: Response): Promise<{ code: string; errors?: { path: string; code: string }[] }> {
  return (await response.json()) as { code: string; errors?: { path: string; code: string }[] };
}

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(50);
  }
}

async function startWorker(logger = recordingLogger()): Promise<void> {
  const config = loadConfig("worker", { ...productionEnv(), NODE_ENV: "test", DATABASE_URL: appUrl(database()) }).config;
  worker = await createWorker({
    config,
    adapters: { ...adapters(), mail },
    modules: [],
    logger,
    database: tenantDatabase(database()),
    pollingIntervalSeconds: POLL_SECONDS,
    shutdownTimeoutMs: 500,
  }).start();
}

/** A workspace of the given people, an owner `o`, an admin `a` and a member `m`; the owner is called Ada Lovelace. */
async function workspace(world: World) {
  const o = await harness.person(world);
  const a = await harness.person(world);
  const m = await harness.person(world);
  const { workspaceId } = await harness.workspaceOf([
    { person: o, role: "owner" },
    { person: a, role: "admin" },
    { person: m, role: "member" },
  ]);
  await setProfile(o.account.id, { displayName: "Ada Lovelace" });
  return { workspaceId, o, a, m };
}

describe("POST /api/v1/invitations", { timeout: TEST_TIMEOUT_MS }, () => {
  it("writes a pending invitation for an admin or an owner, answers the invitation and not its token, and records invitation.created without the address", async () => {
    const world = harness.serve({ entitlements: GRANTED });
    const { workspaceId, o, a } = await workspace(world);

    const first = await invite(world, a, { email: "Grace@Example.test", role: "admin" });
    const second = await invite(world, o, { email: "linus@example.test", role: "member", teamIds: [] });

    expect(first.status).toBe(201);
    const body = (await first.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["createdAt", "email", "expiresAt", "id", "invitedBy", "role", "status", "teamIds"]);
    expect(body).toMatchObject({ email: "Grace@Example.test", role: "admin", status: "pending", teamIds: [], invitedBy: a.account.id });
    expect(second.status).toBe(201);
    const rows = await rowsOf(workspaceId);
    expect(rows.map((row) => [row.email, row.role, row.status, row.invited_by])).toEqual([
      ["Grace@Example.test", "admin", "pending", a.account.id],
      ["linus@example.test", "member", "pending", o.account.id],
    ]);
    expect(rows[0]?.id).toBe((body as { id: string }).id);
    expect(rows[0]?.token_hash).toHaveLength(32);
    // expires seven days after the row was made, by the database's clock
    expect(((rows[0]?.expires_at.getTime() ?? 0) - (rows[0]?.created_at.getTime() ?? 0)) / 1000).toBeCloseTo(7 * 24 * 60 * 60, -1);
    expect(JSON.stringify(body)).not.toContain(rows[0]?.token_hash.toString("hex") ?? "-");
    const events = await auditOf(workspaceId);
    expect(events.map((event) => [event.action, event.entity_type, event.metadata])).toEqual([
      ["invitation.created", "invitation", { role: "admin" }],
      ["invitation.created", "invitation", { role: "member" }],
    ]);
    expect(events.map((event) => event.entity_id)).toEqual(rows.map((row) => row.id));
    expect(JSON.stringify(events)).not.toMatch(/example\.test/);
  });

  it("refuses the owner role at the schema, and a body the operation does not declare, an address that is none and teams, with nothing written or queued", async () => {
    const world = harness.serve({ entitlements: GRANTED, mail });
    const { workspaceId, o } = await workspace(world);
    const before = await checksum(workspaceId);

    const owner = await invite(world, o, { email: "owner@example.test", role: "owner" });
    const unknownRole = await invite(world, o, { email: "owner@example.test", role: "superuser" });
    const noRole = await invite(world, o, { email: "owner@example.test" });
    const extra = await invite(world, o, { email: "owner@example.test", role: "member", instanceIssued: true });
    const badAddress = await invite(world, o, { email: "not an address", role: "member" });
    const teams = await invite(world, o, { email: "teams@example.test", role: "member", teamIds: ["0192f3a0-dddd-7000-8000-000000000001"] });
    const badTeam = await invite(world, o, { email: "teams@example.test", role: "member", teamIds: ["x"] });

    for (const response of [owner, unknownRole, noRole, extra, badAddress, teams, badTeam]) {
      expect(response.status).toBe(422);
    }
    expect((await problemOf(owner)).errors).toEqual([{ path: "role", code: "invalid_value" }]);
    expect(await problemOf(teams)).toMatchObject({ code: "validation_failed", errors: [{ path: "teamIds", code: "teams_unavailable" }] });
    expect(await rowsOf(workspaceId)).toEqual([]);
    expect(await jobsOf(workspaceId)).toEqual([]);
    expect(await checksum(workspaceId)).toBe(before);
  });

  it("refuses a member, a credential that is an API token, an account outside the workspace and a request without a session, and writes nothing", async () => {
    const world = harness.serve({ entitlements: GRANTED, mail });
    const { workspaceId, o, m } = await workspace(world);
    const outsider = await harness.person(world);
    const token = await harness.token(workspaceId, o, "read-write");
    const body = { email: "grace@example.test", role: "member" };

    const asMember = await invite(world, m, body);
    const asToken = await send(world, "POST", INVITATIONS, bearer(token), body);
    const asOutsider = await invite(world, outsider, body);
    const anonymous = await send(world, "POST", INVITATIONS, {}, body);

    expect(asMember.status).toBe(403);
    expect((await problemOf(asMember)).code).toBe("forbidden");
    expect(asToken.status).toBe(403);
    expect(asOutsider.status).toBe(404);
    expect(anonymous.status).toBe(401);
    expect(await rowsOf(workspaceId)).toEqual([]);
    expect(await jobsOf(workspaceId)).toEqual([]);
  });

  it("is refused while no entitlement source holds members.invite, whatever the caller's role, and writes nothing", async () => {
    const closed = harness.serve();
    const refusing = harness.serve({ entitlements: () => false });
    const { workspaceId, o } = await workspace(closed);

    for (const world of [closed, refusing]) {
      const response = await invite(world, o, { email: "grace@example.test", role: "member" });
      expect(response.status).toBe(403);
      expect((await problemOf(response)).code).toBe("entitlement_required");
    }
    expect(await rowsOf(workspaceId)).toEqual([]);
  });

  it("refuses an address that belongs to a member, whatever its case, answers 409 already_member and writes nothing", async () => {
    const world = harness.serve({ entitlements: GRANTED, mail });
    const { workspaceId, o, m } = await workspace(world);
    const before = await checksum(workspaceId);

    const same = await invite(world, o, { email: m.account.email, role: "admin" });
    const upper = await invite(world, o, { email: m.account.email.toUpperCase(), role: "member" });
    const self = await invite(world, o, { email: o.account.email, role: "member" });

    for (const response of [same, upper, self]) {
      expect(response.status).toBe(409);
      expect((await problemOf(response)).code).toBe("already_member");
    }
    expect(await checksum(workspaceId)).toBe(before);
    expect(await jobsOf(workspaceId)).toEqual([]);
  });

  it("answers a member of another workspace's address with an invitation: membership elsewhere is not membership here", async () => {
    const world = harness.serve({ entitlements: GRANTED });
    const a = await workspace(world);
    const b = await workspace(world);

    const response = await invite(world, b.o, { email: a.m.account.email, role: "member" });

    expect(response.status).toBe(201);
    expect(await rowsOf(a.workspaceId)).toEqual([]);
    expect((await rowsOf(b.workspaceId)).map((row) => row.email)).toEqual([a.m.account.email]);
  });

  it("treats an address with a pending invitation as a resend: the same invitation with the new role and a new token hash, one pending row and one job for each request", async () => {
    const world = harness.serve({ entitlements: GRANTED, mail });
    const { workspaceId, o, a } = await workspace(world);

    const first = await invite(world, o, { email: "grace@example.test", role: "member" });
    const [issued] = await rowsOf(workspaceId);
    const second = await invite(world, a, { email: "GRACE@example.test", role: "admin" });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(((await second.json()) as { id: string }).id).toBe(((await first.json()) as { id: string }).id);
    const rows = await rowsOf(workspaceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: issued?.id, email: "grace@example.test", role: "admin", status: "pending", invited_by: a.account.id });
    expect(rows[0]?.token_hash.equals(issued?.token_hash ?? Buffer.alloc(0))).toBe(false);
    expect((await auditOf(workspaceId)).map((event) => event.action)).toEqual(["invitation.created", "invitation.resent"]);
    const jobs = await jobsOf(workspaceId);
    expect(jobs).toHaveLength(2);
    expect(new Set(jobs.map((job) => job.data["invitationId"]))).toEqual(new Set([issued?.id]));
  });

  it("makes one pending invitation of requests for one address that arrive at the same moment", async () => {
    const world = harness.serve({ entitlements: GRANTED, mail });
    const { workspaceId, o, a } = await workspace(world);

    const responses = await Promise.all([o, a, o, a, o].map((person) => invite(world, person, { email: "race@example.test", role: "member" })));

    expect(responses.map((response) => response.status)).toEqual([201, 201, 201, 201, 201]);
    expect(await rowsOf(workspaceId)).toHaveLength(1);
    expect((await auditOf(workspaceId)).map((event) => event.action).sort()).toEqual(["invitation.created", "invitation.resent", "invitation.resent", "invitation.resent", "invitation.resent"]);
    expect(await jobsOf(workspaceId)).toHaveLength(5);
  });

  it("writes the invitation in the workspace the session acts in and in no other: an admin of A who is a member of B invites into B only as B's role allows", async () => {
    const world = harness.serve({ entitlements: GRANTED });
    const a = await workspace(world);
    const b = await workspace(world);
    // The admin of A is a plain member of B, and acts in B.
    await seedMembership(database(), { workspaceId: b.workspaceId, accountId: a.a.account.id, role: "member" });
    await setActiveWorkspace(database(), a.a.sessionId, b.workspaceId);
    const beforeB = await checksum(b.workspaceId);

    const inB = await invite(world, a.a, { email: "grace@example.test", role: "member" });
    expect(inB.status).toBe(403);
    expect(await checksum(b.workspaceId)).toBe(beforeB);

    await setActiveWorkspace(database(), a.a.sessionId, a.workspaceId);
    const inA = await invite(world, a.a, { email: "grace@example.test", role: "member" });

    expect(inA.status).toBe(201);
    expect(await rowsOf(a.workspaceId)).toHaveLength(1);
    expect(await checksum(b.workspaceId)).toBe(beforeB);
    expect(await rowsOf(b.workspaceId)).toEqual([]);
  });

  it("creates the invitation and queues nothing when the deployment cannot send mail", async () => {
    const world = harness.serve({ entitlements: GRANTED });
    const { workspaceId, o } = await workspace(world);

    const response = await invite(world, o, { email: "grace@example.test", role: "member" });

    expect(response.status).toBe(201);
    expect(await rowsOf(workspaceId)).toHaveLength(1);
    expect(await jobsOf(workspaceId)).toEqual([]);
  });

  it("writes neither the invitation nor its audit event when the mail job cannot be queued, and answers an error", async () => {
    const world = harness.serve({ entitlements: GRANTED, mail });
    const { workspaceId, o } = await workspace(world);
    const [queue] = await database().owner`SELECT * FROM pgboss.queue WHERE name = 'invitation.send'`;
    expect(queue).toBeDefined();
    await database().owner`DELETE FROM pgboss.queue WHERE name = 'invitation.send'`;
    let response: Response;
    try {
      response = await invite(world, o, { email: "grace@example.test", role: "member" });
    } finally {
      await database().owner`INSERT INTO pgboss.queue SELECT * FROM json_populate_record(NULL::pgboss.queue, ${JSON.stringify(queue)}::text::json)`;
    }

    expect(response.status).toBe(500);
    expect(await rowsOf(workspaceId)).toEqual([]);
    expect(await auditOf(workspaceId)).toEqual([]);
  });

  it("queues the mail job with identifiers and the language only: no address, no name, no token", async () => {
    const world = harness.serve({ entitlements: GRANTED, mail });
    const { workspaceId, o } = await workspace(world);

    const response = await invite(world, o, { email: "grace@example.test", role: "member" });

    const { id } = (await response.json()) as { id: string };
    const jobs = await jobsOf(workspaceId);
    expect(jobs).toHaveLength(1);
    const { mailTicket, ...identifiers } = jobs[0]?.data ?? {};
    expect(identifiers).toEqual({ invitationId: id, workspaceId, accountId: o.account.id, locale: "en" });
    expect(String(mailTicket)).toMatch(UUID);
  });
});

describe("the invitation email", { timeout: TEST_TIMEOUT_MS }, () => {
  it("is sent with a token whose hash is the stored one, in the invitee's language, naming the workspace, the inviter and the role, and the token is in no job, audit event, log line or response", async () => {
    const world = harness.serve({ entitlements: GRANTED, mail });
    const { workspaceId, o } = await workspace(world);
    const german = await seedAccount(database(), { emailVerified: true });
    await setProfile(german.id, { locale: "de" });
    await setProfile(o.account.id, { locale: "en" });

    const response = await invite(world, o, { email: german.email, role: "admin" });
    const responseText = await response.text();
    const logger = recordingLogger();
    await startWorker(logger);
    await until(() => inbox.sent.length === 1, "the message to reach the mail port");

    const [message] = inbox.sent;
    expect(message).toMatchObject({
      template: "invitation",
      to: german.email,
      locale: "de",
      data: { workspaceName: "Authorization suite", inviterName: "Ada Lovelace", role: "admin" },
    });
    const token = String(message?.data["token"]);
    const hash = hashCredentialToken(token);
    expect(hash).toBeDefined();
    const [row] = await rowsOf(workspaceId);
    expect(row?.token_hash.equals(hash ?? Buffer.alloc(0))).toBe(true);
    expect(message?.data["expiresOn"]).toBe(row?.expires_at.toISOString().slice(0, 10));
    const stores = JSON.stringify([
      await database().owner`SELECT data FROM pgboss.job`,
      await auditOf(workspaceId),
      logger.entries,
      logger.requests,
      responseText,
    ]);
    expect(stores).not.toContain(token);
    expect(stores).not.toContain(createHash("sha256").update(Buffer.from(token, "base64url")).digest("hex"));
  });

  it("is written in the inviter's language when no account holds the address", async () => {
    const world = harness.serve({ entitlements: GRANTED, mail });
    const { o } = await workspace(world);
    await setProfile(o.account.id, { locale: "de" });

    await invite(world, o, { email: "nobody-yet@example.test", role: "member" });
    await startWorker();
    await until(() => inbox.sent.length === 1, "the message to reach the mail port");

    expect(inbox.sent[0]).toMatchObject({ to: "nobody-yet@example.test", locale: "de", data: { role: "member" } });
  });

  it("ends the earlier link when the invitation is sent again: only the token of the latest email matches the stored hash", async () => {
    const world = harness.serve({ entitlements: GRANTED, mail });
    const { workspaceId, o } = await workspace(world);
    await startWorker();

    await invite(world, o, { email: "grace@example.test", role: "member" });
    await until(() => inbox.sent.length === 1, "the first message");
    const firstToken = String(inbox.sent[0]?.data["token"]);
    expect((await rowsOf(workspaceId))[0]?.token_hash.equals(hashCredentialToken(firstToken) ?? Buffer.alloc(0))).toBe(true);
    await invite(world, o, { email: "grace@example.test", role: "member" });
    await until(() => inbox.sent.length === 2, "the second message");

    const secondToken = String(inbox.sent[1]?.data["token"]);
    const [row] = await rowsOf(workspaceId);
    expect(secondToken).not.toBe(firstToken);
    expect(row?.token_hash.equals(hashCredentialToken(secondToken) ?? Buffer.alloc(0))).toBe(true);
    expect(row?.token_hash.equals(hashCredentialToken(firstToken) ?? Buffer.alloc(0))).toBe(false);
    expect(await rowsOf(workspaceId)).toHaveLength(1);
  });

  it("is not sent for an invitation that was revoked or has expired before the worker ran, and the job still ends", async () => {
    const world = harness.serve({ entitlements: GRANTED, mail });
    const { workspaceId, o } = await workspace(world);
    await invite(world, o, { email: "revoked@example.test", role: "member" });
    await invite(world, o, { email: "expired@example.test", role: "member" });
    await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      await tx`UPDATE workspace_invitations SET status = 'revoked', closed_at = now() WHERE workspace_id = ${workspaceId} AND email = 'revoked@example.test'`;
      await tx`UPDATE workspace_invitations SET expires_at = now() - interval '1 minute' WHERE workspace_id = ${workspaceId} AND email = 'expired@example.test'`;
    });
    const before = await rowsOf(workspaceId);

    await startWorker();
    await until(async () => (await jobsOf(workspaceId)).every((job) => job.state === "completed"), "the jobs to end");

    expect(inbox.sent).toEqual([]);
    expect((await rowsOf(workspaceId)).map((row) => row.token_hash.toString("hex"))).toEqual(before.map((row) => row.token_hash.toString("hex")));
  });
});
