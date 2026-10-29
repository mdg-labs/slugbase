import { randomUUID } from "node:crypto";
import { hashCredentialToken } from "@slugbase/core";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EntitlementCheck } from "../../src/http/authorize.ts";
import { seedMembership, seedWorkspace } from "../auth/support.ts";
import { HOOK_TIMEOUT_MS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// POST /api/v1/invitations/inspect and POST /api/v1/invitations/accept through the whole chain over the migrated
// database (doc 04 sections 3.2, 7 and 10.5, doc 02 section 3.4, doc 05 section 3.3, doc 10 T1, T4, T8 and T19).
// The failure scenarios: a token that accepts twice, under parallel requests or after it was used; one that accepts
// after its expiry, its revocation or a newer link replaced it; one that accepts for an account whose verified
// address is not the invited one; a membership with a role other than the invited one, or in another workspace;
// answers that tell an unknown token from an expired, revoked or used one; a refusal that leaves a membership,
// an audit event or a queued event behind; and a redemption that is not counted against the address.

const INVITATIONS = "/api/v1/invitations";
const INSPECT = `${INVITATIONS}/inspect`;
const ACCEPT = `${INVITATIONS}/accept`;
const TEST_TIMEOUT_MS = 60_000;

const database = useTestDatabase();
const harness = workspaceHarness(database);
const GRANTED: EntitlementCheck = (entitlement) => entitlement === "members.invite";

beforeAll(() => harness.start(), HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await database().owner`TRUNCATE pgboss.job`;
});

afterAll(() => harness.stop());

interface Problem {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly detail: string;
  readonly type: string;
  readonly errors?: { path: string; code: string }[];
}

async function problemOf(response: Response): Promise<Problem> {
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  return (await response.json()) as Problem;
}

/** The answer without what differs between two requests. */
async function answerOf(response: Response): Promise<{ status: number; code: string; title: string; detail: string; type: string }> {
  const { status, code, title, detail, type } = await problemOf(response);
  return { status, code, title, detail, type };
}

/** A server whose token_redeem bucket does not limit, unless the test says otherwise. */
function serve(env: Record<string, string> = {}): World {
  return harness.serve({ entitlements: GRANTED, env: { RATE_LIMIT_TOKEN_REDEEM_IP: "10000/hour", RATE_LIMIT_TOKEN_REDEEM_ACCOUNT: "10000/hour", ...env } });
}

/** A workspace called Analytical Engines, of an owner `o` and an admin `a` called Ada Lovelace, who sends the invitations. */
async function workspace(world: World) {
  const o = await harness.person(world);
  const a = await harness.person(world);
  const { workspaceId } = await harness.workspaceOf([
    { person: o, role: "owner" },
    { person: a, role: "admin" },
  ]);
  await database().owner.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${a.account.id}, true)`;
    await tx`UPDATE accounts SET display_name = 'Ada Lovelace' WHERE id = ${a.account.id}`;
  });
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`UPDATE workspaces SET name = 'Analytical Engines' WHERE id = ${workspaceId}`;
  });
  return { workspaceId, o, a };
}

interface Issued {
  readonly id: string;
  readonly token: string;
}

/** Invites `email` and asks for the link of the invitation, which is where a deployment without mail gets the token. */
async function invite(world: World, admin: Person, email: string, role: "admin" | "member" = "member", teamIds: readonly string[] = []): Promise<Issued> {
  const created = await send(world, "POST", INVITATIONS, { cookie: admin.cookie }, { email, role, teamIds });
  expect(created.status).toBe(201);
  const { id } = (await created.json()) as { id: string };
  return { id, token: await linkOf(world, admin, id) };
}

async function linkOf(world: World, admin: Person, id: string): Promise<string> {
  const response = await send(world, "POST", `${INVITATIONS}/${id}/link`, { cookie: admin.cookie });
  expect(response.status).toBe(200);
  const { link } = (await response.json()) as { link: string };
  const token = new URL(link).pathname.split("/").at(-1);
  if (token === undefined || hashCredentialToken(token) === undefined) {
    throw new Error("the link carries no token");
  }
  return token;
}

const inspect = (world: World, token: string): Promise<Response> => send(world, "POST", INSPECT, {}, { token });
const accept = (world: World, person: Person, token: string): Promise<Response> => send(world, "POST", ACCEPT, { cookie: person.cookie }, { token });

/** Moves the expiry of an invitation into the past, as slugbase_system, which the application role may not do. */
async function expire(id: string): Promise<void> {
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`UPDATE workspace_invitations SET expires_at = now() - interval '1 second' WHERE id = ${id}`;
  });
}

/** Marks a workspace as being deleted, as slugbase_system. */
async function markDeleting(workspaceId: string): Promise<void> {
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`UPDATE workspaces SET deleting_at = now() WHERE id = ${workspaceId}`;
  });
}

const rolesOf = (workspaceId: string) => harness.rolesOf(workspaceId);

interface InvitationRow {
  status: string;
  accepted_by: string | null;
  closed_at: Date | null;
}

async function invitationOf(id: string): Promise<InvitationRow> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<InvitationRow[]>`SELECT status, accepted_by, closed_at FROM workspace_invitations WHERE id = ${id}`;
  });
  const row = rows[0];
  if (row === undefined) {
    throw new Error("no such invitation");
  }
  return row;
}

async function seedTeam(workspaceId: string, name: string): Promise<string> {
  const id = randomUUID();
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`INSERT INTO teams (id, workspace_id, name) VALUES (${id}, ${workspaceId}, ${name})`;
  });
  return id;
}

async function teamsOf(accountId: string): Promise<string[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ team_id: string }[]>`SELECT team_id FROM team_members WHERE account_id = ${accountId} ORDER BY team_id`;
  });
  return rows.map((row) => row.team_id);
}

async function membersOfTeam(teamId: string): Promise<string[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ account_id: string }[]>`SELECT account_id FROM team_members WHERE team_id = ${teamId}`;
  });
  return rows.map((row) => row.account_id);
}

async function activeWorkspaceOf(person: Person): Promise<string | null> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ active_workspace_id: string | null }[]>`SELECT active_workspace_id FROM sessions WHERE id = ${person.sessionId}`;
  });
  return rows[0]?.active_workspace_id ?? null;
}

function joinedJobs(workspaceId: string): Promise<{ id: string; data: Record<string, unknown> }[]> {
  return database()
    .app<{ id: string; data: Record<string, unknown> }[]>`SELECT id, data FROM pgboss.job WHERE name = 'event.member.joined' AND data->>'workspaceId' = ${workspaceId}`
    .then((rows) => [...rows]);
}

interface AuditRow {
  action: string;
  actor_account_id: string;
  entity_type: string;
  entity_id: string;
  metadata: Record<string, string>;
  actor_label: string;
}

async function joinedAudit(workspaceId: string): Promise<AuditRow[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<AuditRow[]>`
      SELECT action, actor_account_id, entity_type, entity_id, metadata, actor_label FROM audit_events WHERE workspace_id = ${workspaceId} AND action = 'member.joined'`;
  });
  return [...rows];
}

describe("POST /api/v1/invitations/inspect and /accept", { timeout: TEST_TIMEOUT_MS }, () => {
  it("inspects the invitation anonymously, then accepts it as the invited account with exactly the invited role, in the invited workspace, and makes the workspace the session's active one", async () => {
    const world = serve();
    const { workspaceId, o, a } = await workspace(world);
    const invitee = await harness.person(world);
    const { id, token } = await invite(world, a, invitee.account.email, "admin");

    const inspected = await inspect(world, token);
    expect(inspected.status).toBe(200);
    expect(await inspected.json()).toEqual({
      workspaceName: "Analytical Engines",
      inviterName: "Ada Lovelace",
      email: invitee.account.email,
      role: "admin",
      accountExists: true,
    });
    // inspecting changes nothing: the token still works
    expect((await invitationOf(id)).status).toBe("pending");
    expect(await rolesOf(workspaceId)).not.toHaveProperty(invitee.account.id);
    expect(await activeWorkspaceOf(invitee)).toBeNull();

    const accepted = await accept(world, invitee, token);

    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ workspaceId, role: "admin" });
    expect(await rolesOf(workspaceId)).toEqual({ [o.account.id]: "owner", [a.account.id]: "admin", [invitee.account.id]: "admin" });
    const row = await invitationOf(id);
    expect(row).toMatchObject({ status: "accepted", accepted_by: invitee.account.id });
    expect(row.closed_at).toBeInstanceOf(Date);
    expect(await activeWorkspaceOf(invitee)).toBe(workspaceId);
    const current = await send(world, "GET", "/api/v1/workspace", { cookie: invitee.cookie });
    expect(current.status).toBe(200);
    expect(await current.json()).toMatchObject({ id: workspaceId, role: "admin" });
    expect(await joinedAudit(workspaceId)).toEqual([
      { action: "member.joined", actor_account_id: invitee.account.id, actor_label: "Test account", entity_type: "member", entity_id: invitee.account.id, metadata: { role: "admin" } },
    ]);
    const jobs = await joinedJobs(workspaceId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.data).toEqual({ eventId: jobs[0]?.id, workspaceId, accountId: invitee.account.id, role: "admin" });
    expect(JSON.stringify(jobs[0]?.data)).not.toContain(token);
  });

  it("joins the teams the invitation names with the membership, and a team deleted since the invitation is skipped without failing the acceptance", async () => {
    const world = serve();
    const { workspaceId, a } = await workspace(world);
    const kept = await seedTeam(workspaceId, "Kept");
    const lost = await seedTeam(workspaceId, "Lost");
    const invitee = await harness.person(world);
    const { id, token } = await invite(world, a, invitee.account.email, "member", [kept, lost]);
    await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      await tx`DELETE FROM teams WHERE id = ${lost}`;
    });

    const accepted = await accept(world, invitee, token);

    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ workspaceId, role: "member" });
    expect((await invitationOf(id)).status).toBe("accepted");
    expect(await teamsOf(invitee.account.id)).toEqual([kept]);
  });

  it("joins no team and tells nothing about a team of another workspace: the invitation is refused before it is written, and a stored one is skipped on accept", async () => {
    const world = serve();
    const { workspaceId, a } = await workspace(world);
    const other = await workspace(world);
    const foreign = await seedTeam(other.workspaceId, "Foreign");
    const invitee = await harness.person(world);

    const refused = await send(world, "POST", INVITATIONS, { cookie: a.cookie }, { email: invitee.account.email, role: "member", teamIds: [foreign] });
    expect(refused.status).toBe(422);

    // An invitation that holds the identifier anyway, as one written before the check was made or by other means, still joins nothing of the other workspace.
    const { id, token } = await invite(world, a, invitee.account.email);
    await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      await tx`UPDATE workspace_invitations SET team_ids = ${`{${foreign}}`}::uuid[] WHERE id = ${id}`;
    });
    const accepted = await accept(world, invitee, token);

    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ workspaceId, role: "member" });
    expect(await teamsOf(invitee.account.id)).toEqual([]);
    expect(await membersOfTeam(foreign)).toEqual([]);
    expect(Object.keys(await rolesOf(other.workspaceId))).not.toContain(invitee.account.id);
  });

  it("accepts a token at most once under parallel requests, and answers token_expired to the rest", async () => {
    const world = serve();
    const { workspaceId, a } = await workspace(world);
    const invitee = await harness.person(world);
    const { id, token } = await invite(world, a, invitee.account.email);

    const answers = await Promise.all(Array.from({ length: 6 }, () => accept(world, invitee, token)));

    expect(answers.filter((answer) => answer.status === 200)).toHaveLength(1);
    expect(answers.filter((answer) => answer.status === 410)).toHaveLength(5);
    expect(Object.keys(await rolesOf(workspaceId))).toHaveLength(3);
    expect((await invitationOf(id)).status).toBe("accepted");
    expect(await joinedAudit(workspaceId)).toHaveLength(1);
    expect(await joinedJobs(workspaceId)).toHaveLength(1);
    expect((await accept(world, invitee, token)).status).toBe(410);
    expect((await inspect(world, token)).status).toBe(410);
  });

  it("answers one identical 410 token_expired for an unknown, malformed, expired, revoked, replaced and used token, to the inspection and to the acceptance", async () => {
    const world = serve();
    const { a } = await workspace(world);
    const invitee = await harness.person(world);
    const expired = await invite(world, a, invitee.account.email);
    await expire(expired.id);
    const other = await harness.person(world);
    const revoked = await invite(world, a, other.account.email);
    expect((await send(world, "DELETE", `${INVITATIONS}/${revoked.id}`, { cookie: a.cookie })).status).toBe(204);
    const third = await harness.person(world);
    const replaced = await invite(world, a, third.account.email);
    await linkOf(world, a, replaced.id);
    const fourth = await harness.person(world);
    const used = await invite(world, a, fourth.account.email);
    expect((await accept(world, fourth, used.token)).status).toBe(200);
    const unknown = Buffer.alloc(32, 7).toString("base64url");

    const tokens = [unknown, "not-a-token", "x".repeat(256), expired.token, revoked.token, replaced.token, used.token];
    const inspected = await Promise.all(tokens.map(async (token) => answerOf(await inspect(world, token))));
    const accepted = await Promise.all(tokens.map(async (token) => answerOf(await accept(world, invitee, token))));

    expect(inspected[0]).toMatchObject({ status: 410, code: "token_expired" });
    for (const answer of [...inspected, ...accepted]) {
      expect(answer).toEqual(inspected[0]);
    }
    expect(await invitationOf(expired.id)).toMatchObject({ status: "pending" });
  });

  it("refuses an account whose verified address is not the invited one with 403 forbidden and the field code invitation_email_mismatch, writing nothing, and the right account can still accept", async () => {
    const world = serve();
    const { workspaceId, a } = await workspace(world);
    const invitee = await harness.person(world);
    const stranger = await harness.person(world);
    const { id, token } = await invite(world, a, invitee.account.email, "admin");
    const before = await rolesOf(workspaceId);

    const refused = await accept(world, stranger, token);

    expect(refused.status).toBe(403);
    const problem = await problemOf(refused);
    expect(problem.code).toBe("forbidden");
    expect(problem.errors).toEqual([{ path: "token", code: "invitation_email_mismatch" }]);
    expect(await rolesOf(workspaceId)).toEqual(before);
    expect(await invitationOf(id)).toMatchObject({ status: "pending", accepted_by: null, closed_at: null });
    expect(await activeWorkspaceOf(stranger)).toBe(null);
    expect(await joinedAudit(workspaceId)).toEqual([]);
    expect(await joinedJobs(workspaceId)).toEqual([]);

    expect((await accept(world, invitee, token)).status).toBe(200);
  });

  it("answers 409 already_member to a member, leaving the invitation pending and the role as it was", async () => {
    const world = serve();
    const { workspaceId, a } = await workspace(world);
    const invitee = await harness.person(world);
    const { id, token } = await invite(world, a, invitee.account.email, "admin");
    await seedMembership(database(), { workspaceId, accountId: invitee.account.id, role: "member" });

    const refused = await accept(world, invitee, token);

    expect(refused.status).toBe(409);
    expect((await problemOf(refused)).code).toBe("already_member");
    expect((await rolesOf(workspaceId))[invitee.account.id]).toBe("member");
    expect((await invitationOf(id)).status).toBe("pending");
    expect(await joinedJobs(workspaceId)).toEqual([]);
  });

  it("grants the workspace of the invitation and no other, whatever workspace the session was acting in", async () => {
    const world = serve();
    const { workspaceId, a } = await workspace(world);
    const invitee = await harness.person(world);
    const elsewhere = await seedWorkspace(database(), { name: "Elsewhere" });
    await seedMembership(database(), { workspaceId: elsewhere, accountId: invitee.account.id, role: "member" });
    const { token } = await invite(world, a, invitee.account.email, "member");

    expect((await accept(world, invitee, token)).status).toBe(200);

    expect(await rolesOf(elsewhere)).toEqual({ [invitee.account.id]: "member" });
    expect((await rolesOf(workspaceId))[invitee.account.id]).toBe("member");
  });

  it("refuses an invitation of a workspace that is being deleted, and a request without a session", async () => {
    const world = serve();
    const { workspaceId, a } = await workspace(world);
    const invitee = await harness.person(world);
    const { id, token } = await invite(world, a, invitee.account.email);

    const anonymous = await send(world, "POST", ACCEPT, {}, { token });
    expect(anonymous.status).toBe(401);
    expect(await invitationOf(id)).toMatchObject({ status: "pending" });

    await markDeleting(workspaceId);
    expect((await inspect(world, token)).status).toBe(410);
    expect((await accept(world, invitee, token)).status).toBe(410);
    expect(await rolesOf(workspaceId)).not.toHaveProperty(invitee.account.id);
  });

  it("counts every redemption against the token_redeem bucket of the client address, the inspection and the acceptance together", async () => {
    const world = serve({ RATE_LIMIT_TOKEN_REDEEM_IP: "3/hour" });
    const { a } = await workspace(world);
    const invitee = await harness.person(world);
    const { token } = await invite(world, a, invitee.account.email);
    const unknown = Buffer.alloc(32, 9).toString("base64url");

    expect((await inspect(world, unknown)).status).toBe(410);
    expect((await accept(world, invitee, unknown)).status).toBe(410);
    expect((await inspect(world, unknown)).status).toBe(410);
    const limited = await inspect(world, token);

    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect((await accept(world, invitee, token)).status).toBe(429);
    expect((await problemOf(limited)).code).toBe("rate_limited");
  });
});

describe("the token_redeem limit per account (T9)", () => {
  const from = (address: string) => ({ "x-forwarded-for": address });

  it("counts an account's acceptances across client addresses and leaves another account and the anonymous inspection alone", async () => {
    const world = serve({ TRUSTED_PROXY_HOPS: "1", RATE_LIMIT_TOKEN_REDEEM_ACCOUNT: "2/hour" });
    const { workspaceId, a } = await workspace(world);
    const invitee = await harness.person(world);
    const other = await harness.person(world);
    const { token } = await invite(world, a, invitee.account.email);
    const otherInvitation = await invite(world, a, other.account.email);
    const unknown = Buffer.alloc(32, 9).toString("base64url");
    const acceptFrom = (person: Person, address: string, value: string) =>
      send(world, "POST", ACCEPT, { cookie: person.cookie, ...from(address) }, { token: value });

    expect((await acceptFrom(invitee, "203.0.113.1", unknown)).status).toBe(410);
    expect((await acceptFrom(invitee, "203.0.113.2", unknown)).status).toBe(410);
    const limited = await acceptFrom(invitee, "203.0.113.3", token);

    expect(limited.status).toBe(429);
    expect((await problemOf(limited)).code).toBe("rate_limited");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(await rolesOf(workspaceId)).not.toHaveProperty(invitee.account.id);

    expect((await acceptFrom(other, "203.0.113.4", otherInvitation.token)).status).toBe(200);
    for (const address of ["203.0.113.5", "203.0.113.6", "203.0.113.7"]) {
      expect((await send(world, "POST", INSPECT, from(address), { token: unknown })).status).toBe(410);
    }
  });
});

describe("an invitation for an address no account holds", () => {
  it("is inspected as such, and cannot be accepted without a session: accepting creates no account", async () => {
    const world = serve();
    const { a } = await workspace(world);
    const { token } = await invite(world, a, "nobody-yet@example.test");

    const inspected = await inspect(world, token);

    expect(inspected.status).toBe(200);
    expect(await inspected.json()).toMatchObject({ email: "nobody-yet@example.test", accountExists: false });
    expect((await send(world, "POST", ACCEPT, {}, { token })).status).toBe(401);
  });
});
