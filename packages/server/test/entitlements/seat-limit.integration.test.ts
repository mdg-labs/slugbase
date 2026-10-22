import { LimitedEntitlementSource } from "@slugbase/testing";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ServerModule } from "../../src/create-server.ts";
import type { SeatCheckAnswer, SeatCheckInput } from "../../src/hooks/index.ts";
import { createInvitation, freshAddress, INVITATIONS, invitationRow, linkOf, queuedJobCount, resend, acceptAs, signup, workspaceWithAdmin } from "../invitations/support.ts";
import { HOOK_TIMEOUT_MS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// T11 and T19 at the acceptance of an invitation (doc 01 sections 7.5 and 13.1, doc 02 section 3.4, doc 04 sections 3.2 and
// 10.5, doc 10 T11 and T19): the seat limit of acceptInvitation is the workspace's `seats.max`, replaced by the seat-check
// hooks of the composed modules, and reaches the database operation that counts the members under the workspace's lock. Two
// people accepting the last free seat add one member; the refused invitation stays pending and usable; a hook that fails
// refuses with 503 and writes nothing; sending, resending and listing invitations never count a seat.

const TEST_TIMEOUT_MS = 60_000;
const MEMBER_JOINED_JOB = "event.member.joined";
const ENTITLEMENTS = "/api/v1/entitlements";

const database = useTestDatabase();
const harness = workspaceHarness(database);

beforeAll(() => harness.start(), HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await database().owner`TRUNCATE pgboss.job`;
});

afterAll(() => harness.stop());

interface Problem {
  readonly code: string;
  readonly status: number;
}

async function problemOf(response: Response): Promise<Problem> {
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  return (await response.json()) as Problem;
}

function serve(source: LimitedEntitlementSource, options: { modules?: readonly ServerModule[]; hookTimeoutMs?: number } = {}): World {
  return harness.serve({
    entitlementSource: source,
    mail: { available: true, send: () => Promise.resolve() },
    ...(options.modules === undefined ? {} : { modules: options.modules }),
    ...(options.hookTimeoutMs === undefined ? {} : { hookTimeoutMs: options.hookTimeoutMs }),
    env: { RATE_LIMIT_TOKEN_REDEEM_IP: "10000/hour", RATE_LIMIT_TOKEN_REDEEM_ACCOUNT: "10000/hour", RATE_LIMIT_RESET_IP: "10000/hour", RATE_LIMIT_RESET_EMAIL: "10000/hour" },
  });
}

/** A module whose seat-check hook answers `answer` and records what it was asked. */
function seatModule(answer: (input: SeatCheckInput) => SeatCheckAnswer | Promise<SeatCheckAnswer>, asked: SeatCheckInput[] = []): ServerModule {
  return {
    name: "test/seats",
    hooks: {
      seatCheck: (input) => {
        asked.push(input);
        return answer(input);
      },
    },
    register: () => ({}),
  };
}

/** A workspace of an owner and an admin: two members. */
async function twoMembers(world: World) {
  return workspaceWithAdmin(harness, world);
}

async function invitationOf(world: World, admin: Person, email: string) {
  const id = await createInvitation(world, admin, email);
  return { id, token: await linkOf(world, admin, id) };
}

async function memberCount(workspaceId: string): Promise<number> {
  return Object.keys(await harness.rolesOf(workspaceId)).length;
}

async function accountIdOf(email: string): Promise<string | undefined> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ id: string }[]>`SELECT id FROM accounts WHERE email = ${email}`;
  });
  return rows[0]?.id;
}

describe("accepting an invitation (acceptInvitation) as the signed-in account", () => {
  it(
    "adds one member and answers one 422 seat_limit_reached when two accept the last free seat at once, and the refused invitation stays pending and usable",
    async () => {
      const source = new LimitedEntitlementSource().grant("seats.max", 3);
      const world = serve(source);
      const { workspaceId, admin } = await twoMembers(world);
      const first = await harness.person(world);
      const second = await harness.person(world);
      const firstInvitation = await invitationOf(world, admin, first.account.email);
      const secondInvitation = await invitationOf(world, admin, second.account.email);

      const [a, b] = await Promise.all([acceptAs(world, first, firstInvitation.token), acceptAs(world, second, secondInvitation.token)]);

      expect([a.status, b.status].sort()).toEqual([200, 422]);
      const refused = a.status === 422 ? { response: a, person: first, invitation: firstInvitation } : { response: b, person: second, invitation: secondInvitation };
      expect(await problemOf(refused.response)).toMatchObject({ code: "seat_limit_reached", status: 422 });
      expect(await memberCount(workspaceId)).toBe(3);
      expect((await invitationRow(database(), refused.invitation.id)).status).toBe("pending");
      expect(await queuedJobCount(database(), MEMBER_JOINED_JOB)).toBe(1);

      source.grant("seats.max", 4);
      expect((await acceptAs(world, refused.person, refused.invitation.token)).status).toBe(200);
      expect(await memberCount(workspaceId)).toBe(4);
      expect(await queuedJobCount(database(), MEMBER_JOINED_JOB)).toBe(2);
    },
    TEST_TIMEOUT_MS,
  );

  it("refuses at a limit that equals the members, and a limit of zero, and leaves no membership", async () => {
    const source = new LimitedEntitlementSource().grant("seats.max", 2);
    const world = serve(source);
    const { workspaceId, admin } = await twoMembers(world);
    const invitee = await harness.person(world);
    const target = await invitationOf(world, admin, invitee.account.email);

    const refused = await acceptAs(world, invitee, target.token);
    expect(refused.status).toBe(422);
    expect((await problemOf(refused)).code).toBe("seat_limit_reached");
    source.deny("seats.max");
    expect((await problemOf(await acceptAs(world, invitee, target.token))).code).toBe("seat_limit_reached");
    expect(await memberCount(workspaceId)).toBe(2);
    expect((await invitationRow(database(), target.id)).status).toBe("pending");
    expect(await queuedJobCount(database(), MEMBER_JOINED_JOB)).toBe(0);
    expect(await harness.auditActions(workspaceId)).not.toContain("member.joined");
  }, TEST_TIMEOUT_MS);

  it("keeps accepting under the Community Edition source, which has no ceiling", async () => {
    const world = serve(new LimitedEntitlementSource());
    const { workspaceId, admin } = await twoMembers(world);
    const invitee = await harness.person(world);
    const target = await invitationOf(world, admin, invitee.account.email);

    expect((await acceptAs(world, invitee, target.token)).status).toBe(200);
    expect(await memberCount(workspaceId)).toBe(3);
  }, TEST_TIMEOUT_MS);

  it("sends, resends and lists invitations over the limit without counting a seat", async () => {
    const source = new LimitedEntitlementSource().grant("seats.max", 2);
    const world = serve(source);
    const { workspaceId, admin } = await twoMembers(world);

    const ids: string[] = [];
    for (let sent = 0; sent < 10; sent += 1) {
      ids.push(await createInvitation(world, admin, freshAddress()));
    }
    expect((await resend(world, admin, ids[0] ?? "")).status).toBe(200);
    const listed = await send(world, "GET", `${INVITATIONS}?limit=100`, { cookie: admin.cookie });
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { items: unknown[] }).items).toHaveLength(10);
    expect(await memberCount(workspaceId)).toBe(2);
  }, TEST_TIMEOUT_MS);

  it("reports the seats used and the limit in GET /entitlements, and counts the member the acceptance adds", async () => {
    const source = new LimitedEntitlementSource().grant("seats.max", 3);
    const world = serve(source);
    const { admin } = await twoMembers(world);
    const invitee = await harness.person(world);
    const target = await invitationOf(world, admin, invitee.account.email);

    const body = async () =>
      (await (await send(world, "GET", ENTITLEMENTS, { cookie: admin.cookie })).json()) as { entitlements: Record<string, unknown>; usage: Record<string, number> };
    expect(await body()).toMatchObject({ entitlements: { "seats.max": 3 }, usage: { "seats.used": 2 } });
    expect((await acceptAs(world, invitee, target.token)).status).toBe(200);
    expect(await body()).toMatchObject({ entitlements: { "seats.max": 3 }, usage: { "seats.used": 3 } });
  }, TEST_TIMEOUT_MS);

  it("lets a module's lower limit win over seats.max, and asks its hook for the workspace, the account and the invitation", async () => {
    const asked: SeatCheckInput[] = [];
    const world = serve(new LimitedEntitlementSource().grant("seats.max", 10), { modules: [seatModule(() => ({ seatLimit: 2 }), asked)] });
    const { workspaceId, admin } = await twoMembers(world);
    const invitee = await harness.person(world);
    const target = await invitationOf(world, admin, invitee.account.email);

    const refused = await acceptAs(world, invitee, target.token);
    expect(refused.status).toBe(422);
    expect((await problemOf(refused)).code).toBe("seat_limit_reached");
    expect(await memberCount(workspaceId)).toBe(2);
    expect(asked).toEqual([{ workspaceId, accountId: invitee.account.id, invitationId: target.id }]);
  }, TEST_TIMEOUT_MS);

  it("takes the lowest limit when several modules answer, and a module that allows more than seats.max replaces it", async () => {
    const lowest = serve(new LimitedEntitlementSource(), { modules: [seatModule(() => ({ seatLimit: 9 })), { ...seatModule(() => ({ seatLimit: 2 })), name: "test/other" }] });
    const first = await twoMembers(lowest);
    const invitee = await harness.person(lowest);
    const target = await invitationOf(lowest, first.admin, invitee.account.email);
    expect((await acceptAs(lowest, invitee, target.token)).status).toBe(422);

    const raised = serve(new LimitedEntitlementSource().grant("seats.max", 2), { modules: [seatModule(() => ({ seatLimit: 5 }))] });
    const second = await twoMembers(raised);
    const other = await harness.person(raised);
    const accepted = await invitationOf(raised, second.admin, other.account.email);
    expect((await acceptAs(raised, other, accepted.token)).status).toBe(200);
  }, TEST_TIMEOUT_MS);

  it("answers 503 unavailable and writes nothing when a hook throws, answers outside its contract or does not answer in time", async () => {
    const failing: [string, ServerModule, number | undefined][] = [
      ["throws", seatModule(() => { throw new Error("billing is down"); }), undefined],
      ["answers a limit that is not a count", seatModule(() => ({ seatLimit: -1 })), undefined],
      ["does not answer in time", seatModule(() => new Promise<SeatCheckAnswer>(() => undefined)), 50],
    ];
    for (const [, module, hookTimeoutMs] of failing) {
      const world = serve(new LimitedEntitlementSource(), { modules: [module], ...(hookTimeoutMs === undefined ? {} : { hookTimeoutMs }) });
      const { workspaceId, admin } = await twoMembers(world);
      const invitee = await harness.person(world);
      const target = await invitationOf(world, admin, invitee.account.email);

      const refused = await acceptAs(world, invitee, target.token);
      expect(refused.status).toBe(503);
      expect((await problemOf(refused)).code).toBe("unavailable");
      expect(await memberCount(workspaceId)).toBe(2);
      expect((await invitationRow(database(), target.id)).status).toBe("pending");
      expect(await harness.auditActions(workspaceId)).not.toContain("member.joined");
    }
    expect(await queuedJobCount(database(), MEMBER_JOINED_JOB)).toBe(0);
  }, TEST_TIMEOUT_MS);

  it("answers 403 entitlement_required, not seat_limit_reached, when the workspace lacks members.invite and has no seat left", async () => {
    const source = new LimitedEntitlementSource().grant("seats.max", 2);
    const world = serve(source);
    const { admin } = await twoMembers(world);
    const invitee = await harness.person(world);
    const target = await invitationOf(world, admin, invitee.account.email);
    source.deny("members.invite");

    const refused = await acceptAs(world, invitee, target.token);
    expect(refused.status).toBe(403);
    expect((await problemOf(refused)).code).toBe("entitlement_required");
  }, TEST_TIMEOUT_MS);
});

describe("accepting an invitation (acceptInvitation) with registration fields", () => {
  it("creates no account and no membership at the limit, leaves the invitation pending, and creates both once a seat is free", async () => {
    const source = new LimitedEntitlementSource().grant("seats.max", 2);
    const world = serve(source);
    const { workspaceId, admin } = await twoMembers(world);
    const email = freshAddress();
    const target = await invitationOf(world, admin, email);

    const refused = await signup(world, target.token);
    expect(refused.status).toBe(422);
    expect((await problemOf(refused)).code).toBe("seat_limit_reached");
    expect(await accountIdOf(email)).toBeUndefined();
    expect(await memberCount(workspaceId)).toBe(2);
    expect((await invitationRow(database(), target.id)).status).toBe("pending");
    expect(await queuedJobCount(database(), MEMBER_JOINED_JOB)).toBe(0);

    source.grant("seats.max", 3);
    expect((await signup(world, target.token)).status).toBe(201);
    expect(await memberCount(workspaceId)).toBe(3);
    expect(await queuedJobCount(database(), MEMBER_JOINED_JOB)).toBe(1);
  }, TEST_TIMEOUT_MS);

  it("asks a module's hook about the account the acceptance then creates, and lets its lower limit win", async () => {
    const asked: SeatCheckInput[] = [];
    const answer: { limit: number | null } = { limit: 2 };
    const world = serve(new LimitedEntitlementSource().grant("seats.max", 10), { modules: [seatModule(() => ({ seatLimit: answer.limit }), asked)] });
    const { workspaceId, admin } = await twoMembers(world);
    const email = freshAddress();
    const target = await invitationOf(world, admin, email);

    expect((await signup(world, target.token)).status).toBe(422);
    expect(await accountIdOf(email)).toBeUndefined();

    answer.limit = 3;
    expect((await signup(world, target.token)).status).toBe(201);
    const created = await accountIdOf(email);
    expect(created).toBeDefined();
    expect(asked).toHaveLength(2);
    expect(asked[1]).toEqual({ workspaceId, accountId: created, invitationId: target.id });
  }, TEST_TIMEOUT_MS);

  it("answers 503 unavailable and creates nothing when a hook fails", async () => {
    const world = serve(new LimitedEntitlementSource(), { modules: [seatModule(() => Promise.reject(new Error("billing is down")))] });
    const { workspaceId, admin } = await twoMembers(world);
    const email = freshAddress();
    const target = await invitationOf(world, admin, email);

    const refused = await signup(world, target.token);
    expect(refused.status).toBe(503);
    expect((await problemOf(refused)).code).toBe("unavailable");
    expect(await accountIdOf(email)).toBeUndefined();
    expect(await memberCount(workspaceId)).toBe(2);
    expect((await invitationRow(database(), target.id)).status).toBe("pending");
  }, TEST_TIMEOUT_MS);
});
