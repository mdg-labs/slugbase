import { createHash, randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { hashCredentialToken, type MailPort } from "@slugbase/core";
import { InMemoryMail } from "@slugbase/testing";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/index.ts";
import type { EntitlementCheck } from "../../src/http/authorize.ts";
import { createWorker, type RunningWorker } from "../../src/worker/index.ts";
import { productionEnv } from "../config/support.ts";
import { appUrl, tenantDatabase } from "../contract/support.ts";
import { adapters, recordingLogger } from "../support.ts";
import { HOOK_TIMEOUT_MS, bearer, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// GET /api/v1/invitations, POST /api/v1/invitations/{id}/resend, POST /api/v1/invitations/{id}/link and DELETE
// /api/v1/invitations/{id} through the whole chain over the migrated database (doc 04 section 10.5, doc 02 section 3.4,
// doc 05 section 2.2, doc 10 T1, T4, T7 and T19). The failure scenarios: a resent or re-linked invitation whose earlier
// token still matches the stored hash; an admin of workspace A who lists, resends, links or revokes an invitation of B;
// a link or token that is stored, queued, logged or audited in the clear; a revoked invitation that is resent, linked or
// mailed; a resend that mails nobody or counts against no limit; and a change that is half written when the request fails.

const INVITATIONS = "/api/v1/invitations";
const POLL_SECONDS = 0.5;
const WAIT_MS = 20_000;
const TEST_TIMEOUT_MS = 60_000;
const UNKNOWN = "0192f3a0-eeee-7000-8000-000000000001";

const database = useTestDatabase();
const harness = workspaceHarness(database);
const inbox = new InMemoryMail();
const mail: MailPort = { available: true, send: (message) => inbox.send(message) };
const GRANTED: EntitlementCheck = (entitlement) => entitlement === "members.invite";
let worker: RunningWorker | undefined;

beforeAll(() => harness.start(), HOOK_TIMEOUT_MS);

beforeEach(async () => {
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

/** An invitation row written the way a seed does, as the system role. */
async function seedInvitation(workspaceId: string, email: string, overrides: { status?: string; expiresInSeconds?: number; role?: string } = {}): Promise<{ id: string; hash: Buffer; token: string }> {
  const bytes = randomBytes(32);
  const token = createHash("sha256").update(bytes).digest();
  const id = (await database().owner`SELECT gen_random_uuid()::text AS id`)[0]?.["id"] as string;
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`
      INSERT INTO workspace_invitations (id, workspace_id, email, role, token_hash, status, closed_at, expires_at)
      VALUES (${id}, ${workspaceId}, ${email}, ${overrides.role ?? "member"}, ${token}, ${overrides.status ?? "pending"},
              ${(overrides.status ?? "pending") === "pending" ? null : new Date()}, now() + ${overrides.expiresInSeconds ?? 7 * 24 * 3600} * interval '1 second')`;
  });
  return { id, hash: token, token: bytes.toString("base64url") };
}

interface JobRow {
  readonly state: string;
  readonly data: Record<string, unknown>;
}

function jobsOf(workspaceId: string): Promise<JobRow[]> {
  return database().app<JobRow[]>`SELECT state, data FROM pgboss.job WHERE name = 'invitation.send' AND data->>'workspaceId' = ${workspaceId} ORDER BY created_on`.then((rows) => [...rows]);
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

interface AuditRow {
  readonly action: string;
  readonly entity_type: string | null;
  readonly entity_id: string | null;
  readonly actor_account_id: string | null;
  readonly metadata: Record<string, unknown>;
}

async function auditOf(workspaceId: string): Promise<AuditRow[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<AuditRow[]>`SELECT action, entity_type, entity_id, actor_account_id, metadata FROM audit_events WHERE workspace_id = ${workspaceId} ORDER BY created_at, id`;
  });
  return [...rows];
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

async function problemOf(response: Response): Promise<{ code: string }> {
  return (await response.json()) as { code: string };
}

const list = (world: World, person: Person, query = ""): Promise<Response> => send(world, "GET", `${INVITATIONS}${query}`, { cookie: person.cookie });
const resend = (world: World, person: Person, id: string, headers: Record<string, string> = {}): Promise<Response> =>
  send(world, "POST", `${INVITATIONS}/${id}/resend`, { cookie: person.cookie, ...headers });
const link = (world: World, person: Person, id: string): Promise<Response> => send(world, "POST", `${INVITATIONS}/${id}/link`, { cookie: person.cookie });
const revoke = (world: World, person: Person, id: string): Promise<Response> => send(world, "DELETE", `${INVITATIONS}/${id}`, { cookie: person.cookie });

/** A workspace with an owner `o`, an admin `a` and a member `m`. */
async function workspace(world: World) {
  const o = await harness.person(world);
  const a = await harness.person(world);
  const m = await harness.person(world);
  const { workspaceId } = await harness.workspaceOf([
    { person: o, role: "owner" },
    { person: a, role: "admin" },
    { person: m, role: "member" },
  ]);
  return { workspaceId, o, a, m };
}

function tokenOf(link: string, origin: string): string {
  const prefix = `${origin}/invite/`;
  expect(link.startsWith(prefix)).toBe(true);
  return link.slice(prefix.length);
}

describe("GET /api/v1/invitations", { timeout: TEST_TIMEOUT_MS }, () => {
  it("lists the pending invitations of the workspace newest first for an admin or an owner, with whether each has expired, and never a token, its hash or another status", async () => {
    const world = harness.serve({ entitlements: GRANTED });
    const { workspaceId, o, a } = await workspace(world);
    const first = await seedInvitation(workspaceId, "first@example.test", { role: "admin" });
    const expired = await seedInvitation(workspaceId, "expired@example.test", { expiresInSeconds: -60 });
    await seedInvitation(workspaceId, "revoked@example.test", { status: "revoked" });
    await seedInvitation(workspaceId, "accepted@example.test", { status: "accepted" });
    const last = await seedInvitation(workspaceId, "last@example.test");

    const asAdmin = await list(world, a);
    const asOwner = await list(world, o);

    expect(asAdmin.status).toBe(200);
    const text = await asAdmin.text();
    const body = JSON.parse(text) as { items: { id: string; email: string; role: string; status: string; invitedBy: string | null; expired: boolean; expiresAt: string; createdAt: string; teamIds: string[] }[]; nextCursor: string | null };
    expect(body.items.map((item) => item.id)).toEqual([first.id, expired.id, last.id].sort().reverse());
    expect(Object.fromEntries(body.items.map((item) => [item.email, [item.role, item.status, item.expired]]))).toEqual({
      "first@example.test": ["admin", "pending", false],
      "expired@example.test": ["member", "pending", true],
      "last@example.test": ["member", "pending", false],
    });
    expect(Object.keys(body.items[0] ?? {}).sort()).toEqual(["createdAt", "email", "expired", "expiresAt", "id", "invitedBy", "role", "status", "teamIds"]);
    expect(body.nextCursor).toBeNull();
    for (const hash of [first.hash, expired.hash, last.hash]) {
      expect(text).not.toContain(hash.toString("hex"));
      expect(text).not.toContain(hash.toString("base64url"));
    }
    expect(await asOwner.json()).toEqual(body);
  });

  it("pages with limit and cursor, and refuses a cursor that another workspace issued, a forged one and a limit outside 1 to 100", async () => {
    const world = harness.serve({ entitlements: GRANTED });
    const a = await workspace(world);
    const b = await workspace(world);
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      ids.push((await seedInvitation(a.workspaceId, `page${String(index)}@example.test`)).id);
    }
    await seedInvitation(b.workspaceId, "other@example.test");

    const pages: string[][] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 5; guard += 1) {
      const response = await list(world, a.a, `?limit=2${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`);
      const body = (await response.json()) as { items: { id: string }[]; nextCursor: string | null };
      pages.push(body.items.map((item) => item.id));
      cursor = body.nextCursor;
      if (cursor === null) {
        break;
      }
    }
    const issuedByB = ((await (await list(world, b.a, "?limit=1")).json()) as { nextCursor: string | null }).nextCursor;

    expect(pages.map((page) => page.length)).toEqual([2, 2, 1]);
    expect(pages.flat()).toEqual([...ids].sort().reverse());
    const issuedByA = ((await (await list(world, a.a, "?limit=1")).json()) as { nextCursor: string | null }).nextCursor;
    expect(issuedByA).not.toBeNull();
    expect(issuedByB).toBeNull();
    expect((await list(world, b.a, `?cursor=${encodeURIComponent(issuedByA ?? "")}`)).status).toBe(400);
    expect((await list(world, a.a, "?cursor=forged")).status).toBe(400);
    expect((await list(world, a.a, "?limit=0")).status).toBe(422);
    expect((await list(world, a.a, "?limit=101")).status).toBe(422);
  });

  it("shows an admin of A nothing of B's invitations, and an empty list for a workspace with none", async () => {
    const world = harness.serve({ entitlements: GRANTED });
    const a = await workspace(world);
    const b = await workspace(world);
    await seedInvitation(b.workspaceId, "b-only@example.test");

    const asA = await list(world, a.a);
    const asB = await list(world, b.a);

    expect(await asA.json()).toEqual({ items: [], nextCursor: null });
    expect(((await asB.json()) as { items: { email: string }[] }).items.map((item) => item.email)).toEqual(["b-only@example.test"]);
  });

  it("refuses a member, an API token, an account outside the workspace and a request without a session, and without the entitlement", async () => {
    const world = harness.serve({ entitlements: GRANTED });
    const { workspaceId, o, m } = await workspace(world);
    await seedInvitation(workspaceId, "grace@example.test");
    const outsider = await harness.person(world);
    const token = await harness.token(workspaceId, o, "read-write");
    const closed = harness.serve();

    const asMember = await list(world, m);
    const asToken = await send(world, "GET", INVITATIONS, bearer(token));
    const asOutsider = await list(world, outsider);
    const anonymous = await send(world, "GET", INVITATIONS, {});
    const withoutEntitlement = await list(closed, o);

    expect(asMember.status).toBe(403);
    expect((await problemOf(asMember)).code).toBe("forbidden");
    expect(asToken.status).toBe(403);
    expect(asOutsider.status).toBe(404);
    expect(anonymous.status).toBe(401);
    expect(withoutEntitlement.status).toBe(403);
    expect((await problemOf(withoutEntitlement)).code).toBe("entitlement_required");
  });
});

describe("POST /api/v1/invitations/{id}/resend", { timeout: TEST_TIMEOUT_MS }, () => {
  it("gives the invitation a new expiry and a token nobody holds, ends the earlier link, records invitation.resent and queues one mail job with identifiers only", async () => {
    const world = harness.serve({ entitlements: GRANTED, mail });
    const { workspaceId, o, a } = await workspace(world);
    const seeded = await seedInvitation(workspaceId, "grace@example.test", { role: "admin", expiresInSeconds: 3600 });

    const response = await resend(world, a, seeded.id);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { id: string; email: string; role: string; status: string; invitedBy: string; expiresAt: string };
    expect(body).toMatchObject({ id: seeded.id, email: "grace@example.test", role: "admin", status: "pending", invitedBy: a.account.id });
    const [row] = await rowsOf(workspaceId);
    expect(row?.token_hash.equals(seeded.hash)).toBe(false);
    expect(row?.invited_by).toBe(a.account.id);
    expect(new Date(body.expiresAt).getTime()).toBe(row?.expires_at.getTime());
    expect((row?.expires_at.getTime() ?? 0) - Date.now()).toBeGreaterThan(6 * 24 * 3600 * 1000);
    const events = await auditOf(workspaceId);
    expect(events).toEqual([{ action: "invitation.resent", entity_type: "invitation", entity_id: seeded.id, actor_account_id: a.account.id, metadata: { role: "admin" } }]);
    expect(JSON.stringify(events)).not.toContain("example.test");
    const jobs = await jobsOf(workspaceId);
    expect(jobs.map((job) => job.data)).toEqual([{ invitationId: seeded.id, workspaceId, accountId: a.account.id, locale: "en" }]);
    expect((await resend(world, o, seeded.id)).status).toBe(200);
  });

  it("mails the invitee a link whose token is the only one that matches the stored hash: the earlier token is refused", async () => {
    const world = harness.serve({ entitlements: GRANTED, mail });
    const { workspaceId, a } = await workspace(world);
    const logger = recordingLogger();
    await startWorker(logger);
    const seeded = await seedInvitation(workspaceId, "grace@example.test");
    expect(hashCredentialToken(seeded.token)?.equals(seeded.hash)).toBe(true);

    const response = await resend(world, a, seeded.id);
    const text = await response.text();
    await until(() => inbox.sent.length === 1, "the message to reach the mail port");

    expect(response.status).toBe(200);
    const token = String(inbox.sent[0]?.data["token"]);
    const [row] = await rowsOf(workspaceId);
    expect(inbox.sent[0]).toMatchObject({ template: "invitation", to: "grace@example.test", locale: "en", data: { role: "member" } });
    expect(row?.token_hash.equals(hashCredentialToken(token) ?? Buffer.alloc(0))).toBe(true);
    expect(row?.token_hash.equals(hashCredentialToken(seeded.token) ?? Buffer.alloc(0))).toBe(false);
    const stores = JSON.stringify([await database().owner`SELECT data FROM pgboss.job`, await auditOf(workspaceId), logger.entries, logger.requests, text]);
    expect(stores).not.toContain(token);
  });

  it("ends the link of the first resend when a second one is sent: only the token of the latest email matches", async () => {
    const world = harness.serve({ entitlements: GRANTED, mail });
    const { workspaceId, o } = await workspace(world);
    await startWorker();
    const seeded = await seedInvitation(workspaceId, "grace@example.test");

    await resend(world, o, seeded.id);
    await until(() => inbox.sent.length === 1, "the first message");
    await resend(world, o, seeded.id);
    await until(() => inbox.sent.length === 2, "the second message");

    const [first, second] = inbox.sent.map((message) => String(message.data["token"]));
    const [row] = await rowsOf(workspaceId);
    expect(first).not.toBe(second);
    expect(row?.token_hash.equals(hashCredentialToken(second ?? "") ?? Buffer.alloc(0))).toBe(true);
    expect(row?.token_hash.equals(hashCredentialToken(first ?? "") ?? Buffer.alloc(0))).toBe(false);
    expect(await rowsOf(workspaceId)).toHaveLength(1);
  });

  it("renews an invitation that has expired", async () => {
    const world = harness.serve({ entitlements: GRANTED, mail });
    const { workspaceId, a } = await workspace(world);
    const seeded = await seedInvitation(workspaceId, "late@example.test", { expiresInSeconds: -3600 });

    const response = await resend(world, a, seeded.id);

    expect(response.status).toBe(200);
    expect((await rowsOf(workspaceId))[0]?.expires_at.getTime()).toBeGreaterThan(Date.now());
  });

  it("answers 404 for an invitation of another workspace, a revoked or accepted one and one that never existed, and changes nothing of workspace B", async () => {
    const world = harness.serve({ entitlements: GRANTED, mail });
    const a = await workspace(world);
    const b = await workspace(world);
    const foreign = await seedInvitation(b.workspaceId, "foreign@example.test");
    const revoked = await seedInvitation(a.workspaceId, "revoked@example.test", { status: "revoked" });
    const accepted = await seedInvitation(a.workspaceId, "accepted@example.test", { status: "accepted" });
    const beforeA = await checksum(a.workspaceId);
    const beforeB = await checksum(b.workspaceId);

    const responses = await Promise.all([foreign.id, revoked.id, accepted.id, UNKNOWN].map((id) => resend(world, a.a, id)));

    expect(responses.map((response) => response.status)).toEqual([404, 404, 404, 404]);
    expect(await Promise.all(responses.map(async (response) => (await problemOf(response)).code))).toEqual(["not_found", "not_found", "not_found", "not_found"]);
    expect(await checksum(b.workspaceId)).toBe(beforeB);
    expect(await checksum(a.workspaceId)).toBe(beforeA);
    expect(await jobsOf(a.workspaceId)).toEqual([]);
    expect(await jobsOf(b.workspaceId)).toEqual([]);
  });

  it("refuses a member, an API token, an account outside the workspace, a request without a session and one without the entitlement, and writes nothing", async () => {
    const world = harness.serve({ entitlements: GRANTED, mail });
    const { workspaceId, o, m } = await workspace(world);
    const seeded = await seedInvitation(workspaceId, "grace@example.test");
    const outsider = await harness.person(world);
    const token = await harness.token(workspaceId, o, "read-write");
    const closed = harness.serve({ mail });
    const before = await checksum(workspaceId);

    const asMember = await resend(world, m, seeded.id);
    const asToken = await send(world, "POST", `${INVITATIONS}/${seeded.id}/resend`, bearer(token));
    const asOutsider = await resend(world, outsider, seeded.id);
    const anonymous = await send(world, "POST", `${INVITATIONS}/${seeded.id}/resend`, {});
    const withoutEntitlement = await resend(closed, o, seeded.id);

    expect([asMember.status, asToken.status, asOutsider.status, anonymous.status, withoutEntitlement.status]).toEqual([403, 403, 404, 401, 403]);
    expect((await problemOf(withoutEntitlement)).code).toBe("entitlement_required");
    expect(await checksum(workspaceId)).toBe(before);
    expect(await jobsOf(workspaceId)).toEqual([]);
  });

  it("is refused with 503 mail_unavailable where no mail can be sent, and leaves the earlier link working", async () => {
    const world = harness.serve({ entitlements: GRANTED });
    const { workspaceId, a } = await workspace(world);
    const seeded = await seedInvitation(workspaceId, "grace@example.test");
    const before = await checksum(workspaceId);

    const response = await resend(world, a, seeded.id);

    expect(response.status).toBe(503);
    expect((await problemOf(response)).code).toBe("mail_unavailable");
    expect(await checksum(workspaceId)).toBe(before);
    expect((await rowsOf(workspaceId))[0]?.token_hash.equals(seeded.hash)).toBe(true);
  });

  it("writes neither the new token nor its audit event when the mail job cannot be queued, and answers an error", async () => {
    const world = harness.serve({ entitlements: GRANTED, mail });
    const { workspaceId, a } = await workspace(world);
    const seeded = await seedInvitation(workspaceId, "grace@example.test");
    const before = await checksum(workspaceId);
    const [queue] = await database().owner`SELECT * FROM pgboss.queue WHERE name = 'invitation.send'`;
    expect(queue).toBeDefined();
    await database().owner`DELETE FROM pgboss.queue WHERE name = 'invitation.send'`;
    let response: Response;
    try {
      response = await resend(world, a, seeded.id);
    } finally {
      await database().owner`INSERT INTO pgboss.queue SELECT * FROM json_populate_record(NULL::pgboss.queue, ${JSON.stringify(queue)}::text::json)`;
    }

    expect(response.status).toBe(500);
    expect(await checksum(workspaceId)).toBe(before);
    expect((await rowsOf(workspaceId))[0]?.token_hash.equals(seeded.hash)).toBe(true);
  });

  it("allows 3 resends per hour to one address, in any spelling, and answers the fourth 429 with Retry-After and changes nothing", async () => {
    const world = harness.serve({ entitlements: GRANTED, mail, env: { RATE_LIMIT_RESET_IP: "1000/hour", RATE_LIMIT_RESET_EMAIL: "3/hour" } });
    const { workspaceId, o } = await workspace(world);
    const seeded = await seedInvitation(workspaceId, "Target.Person@Example.test");
    const other = await seedInvitation(workspaceId, "someone.else@example.test");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await resend(world, o, seeded.id)).status).toBe(200);
    }
    const before = await checksum(workspaceId);
    const jobs = (await jobsOf(workspaceId)).length;

    const denied = await resend(world, o, seeded.id);

    expect(denied.status).toBe(429);
    expect(Number(denied.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await problemOf(denied)).code).toBe("rate_limited");
    expect(await checksum(workspaceId)).toBe(before);
    expect(await jobsOf(workspaceId)).toHaveLength(jobs);
    expect((await resend(world, o, other.id)).status).toBe(200);
  });

  it("allows 5 resends per hour from one address and answers the sixth 429, counting each address on its own", async () => {
    const world = harness.serve({ entitlements: GRANTED, mail, env: { RATE_LIMIT_RESET_IP: "5/hour", RATE_LIMIT_RESET_EMAIL: "1000/hour", TRUSTED_PROXY_HOPS: "1" } });
    const { workspaceId, o } = await workspace(world);
    const ids: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      ids.push((await seedInvitation(workspaceId, `flood${String(index)}@example.test`)).id);
    }
    const from = (address: string) => ({ "x-forwarded-for": address });
    for (const id of ids.slice(0, 5)) {
      expect((await resend(world, o, id, from("198.51.100.7"))).status).toBe(200);
    }

    const denied = await resend(world, o, ids[5] ?? "", from("198.51.100.7"));

    expect(denied.status).toBe(429);
    expect(Number(denied.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await resend(world, o, ids[5] ?? "", from("198.51.100.8"))).status).toBe(200);
  });

  it("does not count a request for an invitation that does not exist against any address's limit", async () => {
    const world = harness.serve({ entitlements: GRANTED, mail, env: { RATE_LIMIT_RESET_IP: "1000/hour", RATE_LIMIT_RESET_EMAIL: "1/hour" } });
    const { workspaceId, o } = await workspace(world);
    const seeded = await seedInvitation(workspaceId, "grace@example.test");

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await resend(world, o, UNKNOWN)).status).toBe(404);
    }

    expect((await resend(world, o, seeded.id)).status).toBe(200);
  });
});

describe("POST /api/v1/invitations/{id}/link", { timeout: TEST_TIMEOUT_MS }, () => {
  it("returns the link of a new token once, stores only its hash, ends the earlier token, records invitation.link_created and sends no mail, where mail cannot be sent", async () => {
    const logger = recordingLogger();
    const world = harness.serve({ entitlements: GRANTED, logger });
    const { workspaceId, a } = await workspace(world);
    const seeded = await seedInvitation(workspaceId, "grace@example.test", { role: "admin", expiresInSeconds: 3600 });

    const response = await link(world, a, seeded.id);

    expect(response.status).toBe(200);
    const text = await response.text();
    const body = JSON.parse(text) as { invitation: { id: string; email: string; role: string; status: string; expiresAt: string; invitedBy: string }; link: string };
    expect(Object.keys(body).sort()).toEqual(["invitation", "link"]);
    expect(body.invitation).toMatchObject({ id: seeded.id, email: "grace@example.test", role: "admin", status: "pending", invitedBy: a.account.id });
    const token = tokenOf(body.link, world.origin);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [row] = await rowsOf(workspaceId);
    expect(row?.token_hash.equals(hashCredentialToken(token) ?? Buffer.alloc(0))).toBe(true);
    expect(row?.token_hash.equals(hashCredentialToken(seeded.token) ?? Buffer.alloc(0))).toBe(false);
    expect(new Date(body.invitation.expiresAt).getTime()).toBe(row?.expires_at.getTime());
    expect((row?.expires_at.getTime() ?? 0) - Date.now()).toBeGreaterThan(6 * 24 * 3600 * 1000);
    const events = await auditOf(workspaceId);
    expect(events).toEqual([{ action: "invitation.link_created", entity_type: "invitation", entity_id: seeded.id, actor_account_id: a.account.id, metadata: { role: "admin" } }]);
    expect(await jobsOf(workspaceId)).toEqual([]);
    const elsewhere = JSON.stringify([events, logger.entries, logger.requests, await database().owner`SELECT data FROM pgboss.job`]);
    expect(elsewhere).not.toContain(token);
    expect(elsewhere).not.toContain(createHash("sha256").update(Buffer.from(token, "base64url")).digest("hex"));
  });

  it("makes another token for every request, so only the latest link matches the stored hash, whatever sent the earlier one", async () => {
    const world = harness.serve({ entitlements: GRANTED, mail });
    const { workspaceId, o, a } = await workspace(world);
    const seeded = await seedInvitation(workspaceId, "grace@example.test");

    const first = ((await (await link(world, a, seeded.id)).json()) as { link: string }).link;
    const second = ((await (await link(world, o, seeded.id)).json()) as { link: string }).link;

    const [firstToken, secondToken] = [tokenOf(first, world.origin), tokenOf(second, world.origin)];
    const [row] = await rowsOf(workspaceId);
    expect(firstToken).not.toBe(secondToken);
    expect(row?.token_hash.equals(hashCredentialToken(secondToken) ?? Buffer.alloc(0))).toBe(true);
    expect(row?.token_hash.equals(hashCredentialToken(firstToken) ?? Buffer.alloc(0))).toBe(false);
    expect(row?.token_hash.equals(seeded.hash)).toBe(false);
    expect(row?.invited_by).toBe(o.account.id);
  });

  it("works where mail is configured as well, sends no email and queues no job, and ends the token a mailed link carried", async () => {
    const world = harness.serve({ entitlements: GRANTED, mail });
    const { workspaceId, a } = await workspace(world);
    await startWorker();
    const seeded = await seedInvitation(workspaceId, "grace@example.test");
    await resend(world, a, seeded.id);
    await until(() => inbox.sent.length === 1, "the message");
    const mailed = String(inbox.sent[0]?.data["token"]);
    inbox.clear();

    const response = await link(world, a, seeded.id);

    expect(response.status).toBe(200);
    const token = tokenOf(((await response.json()) as { link: string }).link, world.origin);
    const [row] = await rowsOf(workspaceId);
    expect(row?.token_hash.equals(hashCredentialToken(token) ?? Buffer.alloc(0))).toBe(true);
    expect(row?.token_hash.equals(hashCredentialToken(mailed) ?? Buffer.alloc(0))).toBe(false);
    expect(await jobsOf(workspaceId)).toHaveLength(1);
    expect(inbox.sent).toEqual([]);
  });

  it("renews an invitation that has expired", async () => {
    const world = harness.serve({ entitlements: GRANTED });
    const { workspaceId, a } = await workspace(world);
    const seeded = await seedInvitation(workspaceId, "late@example.test", { expiresInSeconds: -3600 });

    const response = await link(world, a, seeded.id);

    expect(response.status).toBe(200);
    expect((await rowsOf(workspaceId))[0]?.expires_at.getTime()).toBeGreaterThan(Date.now());
  });

  it("answers 404 for an invitation of another workspace, a revoked or accepted one and one that never existed, returns no link and changes nothing of workspace B", async () => {
    const world = harness.serve({ entitlements: GRANTED });
    const a = await workspace(world);
    const b = await workspace(world);
    const foreign = await seedInvitation(b.workspaceId, "foreign@example.test");
    const revoked = await seedInvitation(a.workspaceId, "revoked@example.test", { status: "revoked" });
    const accepted = await seedInvitation(a.workspaceId, "accepted@example.test", { status: "accepted" });
    const beforeA = await checksum(a.workspaceId);
    const beforeB = await checksum(b.workspaceId);

    const responses = await Promise.all([foreign.id, revoked.id, accepted.id, UNKNOWN].map((id) => link(world, a.a, id)));

    expect(responses.map((response) => response.status)).toEqual([404, 404, 404, 404]);
    for (const response of responses) {
      expect(await response.text()).not.toContain("/invite/");
    }
    expect(await checksum(b.workspaceId)).toBe(beforeB);
    expect(await checksum(a.workspaceId)).toBe(beforeA);
  });

  it("refuses a member, an API token, an account outside the workspace, a request without a session and one without the entitlement, and writes nothing", async () => {
    const world = harness.serve({ entitlements: GRANTED });
    const { workspaceId, o, m } = await workspace(world);
    const seeded = await seedInvitation(workspaceId, "grace@example.test");
    const outsider = await harness.person(world);
    const token = await harness.token(workspaceId, o, "read-write");
    const closed = harness.serve();
    const before = await checksum(workspaceId);

    const asMember = await link(world, m, seeded.id);
    const asToken = await send(world, "POST", `${INVITATIONS}/${seeded.id}/link`, bearer(token));
    const asOutsider = await link(world, outsider, seeded.id);
    const anonymous = await send(world, "POST", `${INVITATIONS}/${seeded.id}/link`, {});
    const withoutEntitlement = await link(closed, o, seeded.id);

    expect([asMember.status, asToken.status, asOutsider.status, anonymous.status, withoutEntitlement.status]).toEqual([403, 403, 404, 401, 403]);
    for (const response of [asMember, asToken, asOutsider, anonymous, withoutEntitlement]) {
      expect(await response.text()).not.toContain("/invite/");
    }
    expect(await checksum(workspaceId)).toBe(before);
  });

  it("is a no-store answer", async () => {
    const world = harness.serve({ entitlements: GRANTED });
    const { workspaceId, a } = await workspace(world);
    const seeded = await seedInvitation(workspaceId, "grace@example.test");

    const response = await link(world, a, seeded.id);

    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("DELETE /api/v1/invitations/{id}", { timeout: TEST_TIMEOUT_MS }, () => {
  it("revokes a pending invitation with 204, keeps its row, records invitation.revoked, and answers a repeat with 204 and no second event", async () => {
    const world = harness.serve({ entitlements: GRANTED });
    const { workspaceId, o, a } = await workspace(world);
    const seeded = await seedInvitation(workspaceId, "grace@example.test", { role: "admin" });

    const first = await revoke(world, a, seeded.id);
    const second = await revoke(world, o, seeded.id);

    expect(first.status).toBe(204);
    expect(await first.text()).toBe("");
    expect(second.status).toBe(204);
    const rows = await rowsOf(workspaceId);
    expect(rows.map((row) => [row.id, row.status])).toEqual([[seeded.id, "revoked"]]);
    expect(rows[0]?.token_hash.equals(seeded.hash)).toBe(true);
    expect(await auditOf(workspaceId)).toEqual([{ action: "invitation.revoked", entity_type: "invitation", entity_id: seeded.id, actor_account_id: a.account.id, metadata: { role: "admin" } }]);
  });

  it("is not on the list any more, and can be neither resent nor given a link, and the mail job already queued for it sends nothing", async () => {
    const world = harness.serve({ entitlements: GRANTED, mail });
    const { workspaceId, a } = await workspace(world);
    const seeded = await seedInvitation(workspaceId, "grace@example.test");
    await resend(world, a, seeded.id);
    const hashBefore = (await rowsOf(workspaceId))[0]?.token_hash;

    await revoke(world, a, seeded.id);
    const listed = (await (await list(world, a)).json()) as { items: unknown[] };
    const resent = await resend(world, a, seeded.id);
    const linked = await link(world, a, seeded.id);
    await startWorker();
    await until(async () => (await jobsOf(workspaceId)).every((job) => job.state === "completed"), "the job to end");

    expect(listed.items).toEqual([]);
    expect([resent.status, linked.status]).toEqual([404, 404]);
    expect(inbox.sent).toEqual([]);
    expect((await rowsOf(workspaceId))[0]?.token_hash.equals(hashBefore ?? Buffer.alloc(0))).toBe(true);
    expect((await rowsOf(workspaceId))[0]?.status).toBe("revoked");
  });

  it("revokes an invitation that has expired, and works without the members.invite entitlement", async () => {
    const world = harness.serve({ entitlements: () => false });
    const { workspaceId, a } = await workspace(world);
    const seeded = await seedInvitation(workspaceId, "late@example.test", { expiresInSeconds: -3600 });

    const response = await revoke(world, a, seeded.id);

    expect(response.status).toBe(204);
    expect((await rowsOf(workspaceId))[0]?.status).toBe("revoked");
  });

  it("answers 404 for an invitation of another workspace, an accepted one and one that never existed, and changes nothing of workspace B", async () => {
    const world = harness.serve({ entitlements: GRANTED });
    const a = await workspace(world);
    const b = await workspace(world);
    const foreign = await seedInvitation(b.workspaceId, "foreign@example.test");
    const foreignRevoked = await seedInvitation(b.workspaceId, "foreign-revoked@example.test", { status: "revoked" });
    const accepted = await seedInvitation(a.workspaceId, "accepted@example.test", { status: "accepted" });
    const beforeA = await checksum(a.workspaceId);
    const beforeB = await checksum(b.workspaceId);

    const responses = await Promise.all([foreign.id, foreignRevoked.id, accepted.id, UNKNOWN].map((id) => revoke(world, a.a, id)));

    expect(responses.map((response) => response.status)).toEqual([404, 404, 404, 404]);
    expect(await Promise.all(responses.map(async (response) => (await problemOf(response)).code))).toEqual(["not_found", "not_found", "not_found", "not_found"]);
    expect(await checksum(b.workspaceId)).toBe(beforeB);
    expect(await checksum(a.workspaceId)).toBe(beforeA);
  });

  it("refuses a member, an API token, an account outside the workspace and a request without a session, and revokes nothing", async () => {
    const world = harness.serve({ entitlements: GRANTED });
    const { workspaceId, o, m } = await workspace(world);
    const seeded = await seedInvitation(workspaceId, "grace@example.test");
    const outsider = await harness.person(world);
    const token = await harness.token(workspaceId, o, "read-write");
    const before = await checksum(workspaceId);

    const asMember = await revoke(world, m, seeded.id);
    const asToken = await send(world, "DELETE", `${INVITATIONS}/${seeded.id}`, bearer(token));
    const asOutsider = await revoke(world, outsider, seeded.id);
    const anonymous = await send(world, "DELETE", `${INVITATIONS}/${seeded.id}`, {});

    expect([asMember.status, asToken.status, asOutsider.status, anonymous.status]).toEqual([403, 403, 404, 401]);
    expect(await checksum(workspaceId)).toBe(before);
  });

  it("refuses an identifier that is not a UUID", async () => {
    const world = harness.serve({ entitlements: GRANTED });
    const { a } = await workspace(world);

    expect((await revoke(world, a, "not-a-uuid")).status).toBe(422);
    expect((await link(world, a, "not-a-uuid")).status).toBe(422);
    expect((await resend(world, a, "not-a-uuid")).status).toBe(422);
  });
});
