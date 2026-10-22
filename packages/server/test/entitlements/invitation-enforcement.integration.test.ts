import { LimitedEntitlementSource } from "@slugbase/testing";
import { useTestDatabase } from "@slugbase/testing/db";
import type { WorkspaceEntitlementGrant } from "@slugbase/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { signInAdmin } from "../instance/support.ts";
import { createInvitation, freshAddress, INVITATIONS, invitationRow, linkOf, queuedJobCount, resend, revoke, acceptAs, signup, workspaceWithAdmin } from "../invitations/support.ts";
import { HOOK_TIMEOUT_MS, send, workspaceHarness, type World } from "../workspaces/support.ts";

// T11 at the invitation operations (doc 01 section 7.5, doc 04 sections 1.2 and 3.2, doc 10 T3 and T11): with the
// entitlement source withholding `members.invite`, creating, listing, resending and linking an invitation answer
// 403 entitlement_required before the handler writes anything, accepting one answers it and creates no membership
// and no account, and revoking one still works. The Community Edition source (the full, unlimited source) leaves
// every one of them working. The owner invitation an instance admin issues for a workspace is the exception: seating
// the first owner of a workspace is not the feature `members.invite` names, so accepting it asks the source nothing.

const TEST_TIMEOUT_MS = 60_000;
const MAIL_JOB = "invitation.send";

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
  readonly entitlement?: unknown;
  readonly upgradeAvailable?: unknown;
}

async function problemOf(response: Response): Promise<Problem> {
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  return (await response.json()) as Problem;
}

const mail = { available: true, send: () => Promise.resolve() } as const;

function serve(source: LimitedEntitlementSource): World {
  return harness.serve({
    entitlementSource: source,
    mail,
    env: { RATE_LIMIT_TOKEN_REDEEM_IP: "10000/hour", RATE_LIMIT_TOKEN_REDEEM_ACCOUNT: "10000/hour", RATE_LIMIT_RESET_IP: "10000/hour", RATE_LIMIT_RESET_EMAIL: "10000/hour" },
  });
}

/** Raises the entitlement version of the workspace's row, as a change of plan does, so the process cache reads the source again. */
async function bumpVersion(workspaceId: string): Promise<void> {
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`UPDATE workspaces SET entitlement_version = entitlement_version + 1 WHERE id = ${workspaceId}`;
  });
}

async function invitationCount(workspaceId: string): Promise<number> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ count: number }[]>`SELECT count(*)::int AS count FROM workspace_invitations WHERE workspace_id = ${workspaceId}`;
  });
  return rows[0]?.count ?? -1;
}

async function accountCount(email: string): Promise<number> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ count: number }[]>`SELECT count(*)::int AS count FROM accounts WHERE email = ${email}`;
  });
  return rows[0]?.count ?? -1;
}

describe("the operations that create, list, resend and link invitations", () => {
  it(
    "answer 403 entitlement_required with the entitlement and the upgrade flag when the source withholds members.invite, and write nothing",
    async () => {
      const source = new LimitedEntitlementSource().deny("members.invite");
      const world = serve(source);
      const { workspaceId, admin } = await workspaceWithAdmin(harness, world);

      const created = await send(world, "POST", INVITATIONS, { cookie: admin.cookie }, { email: freshAddress(), role: "member" });
      expect(created.status).toBe(403);
      expect(await problemOf(created)).toMatchObject({ code: "entitlement_required", status: 403, entitlement: "members.invite", upgradeAvailable: false });
      expect(await invitationCount(workspaceId)).toBe(0);
      expect(await queuedJobCount(database(), MAIL_JOB)).toBe(0);

      const listed = await send(world, "GET", INVITATIONS, { cookie: admin.cookie });
      expect(listed.status).toBe(403);
      expect((await problemOf(listed)).code).toBe("entitlement_required");
    },
    TEST_TIMEOUT_MS,
  );

  it("say whether the plan has a better one to offer", async () => {
    const world = serve(new LimitedEntitlementSource().deny("members.invite").offerUpgrade(true));
    const { admin } = await workspaceWithAdmin(harness, world);
    const refused = await send(world, "POST", INVITATIONS, { cookie: admin.cookie }, { email: freshAddress(), role: "member" });
    expect(await problemOf(refused)).toMatchObject({ code: "entitlement_required", entitlement: "members.invite", upgradeAvailable: true });
  }, TEST_TIMEOUT_MS);

  it("keep working under the Community Edition source", async () => {
    const world = serve(new LimitedEntitlementSource());
    const { workspaceId, admin } = await workspaceWithAdmin(harness, world);
    const id = await createInvitation(world, admin, freshAddress());
    expect(await invitationCount(workspaceId)).toBe(1);
    expect(await queuedJobCount(database(), MAIL_JOB)).toBe(1);
    expect((await send(world, "GET", INVITATIONS, { cookie: admin.cookie })).status).toBe(200);
    expect((await resend(world, admin, id)).status).toBe(200);
    await linkOf(world, admin, id);
  }, TEST_TIMEOUT_MS);

  it("refuse resending and linking an invitation once the source withholds the entitlement, and leave revoking it open", async () => {
    const source = new LimitedEntitlementSource();
    const world = serve(source);
    const { workspaceId, admin } = await workspaceWithAdmin(harness, world);
    const id = await createInvitation(world, admin, freshAddress());
    const before = await invitationRow(database(), id);

    source.deny("members.invite");
    await bumpVersion(workspaceId);
    const resent = await resend(world, admin, id);
    expect(resent.status).toBe(403);
    expect((await problemOf(resent)).code).toBe("entitlement_required");
    const linked = await send(world, "POST", `${INVITATIONS}/${id}/link`, { cookie: admin.cookie });
    expect(linked.status).toBe(403);
    expect((await problemOf(linked)).code).toBe("entitlement_required");
    expect((await invitationRow(database(), id)).token_hash.equals(before.token_hash)).toBe(true);

    expect((await revoke(world, admin, id)).status).toBe(204);
    expect((await invitationRow(database(), id)).status).toBe("revoked");
  }, TEST_TIMEOUT_MS);
});

describe("accepting an invitation (acceptInvitation)", () => {
  async function serveWorkspace() {
    const source = new LimitedEntitlementSource();
    const world = serve(source);
    const { workspaceId, admin } = await workspaceWithAdmin(harness, world);
    return { source, world, workspaceId, admin };
  }

  it("answers 403 entitlement_required for the signed-in account and creates no membership when the workspace of the invitation lacks members.invite", async () => {
    const { source, world, workspaceId, admin } = await serveWorkspace();
    const invitee = await harness.person(world);
    const id = await createInvitation(world, admin, invitee.account.email);
    const token = await linkOf(world, admin, id);
    const members = await harness.rolesOf(workspaceId);
    source.deny("members.invite");
    await bumpVersion(workspaceId);

    const refused = await acceptAs(world, invitee, token);
    expect(refused.status).toBe(403);
    expect(await problemOf(refused)).toMatchObject({ code: "entitlement_required", entitlement: "members.invite", upgradeAvailable: false });
    expect(await harness.rolesOf(workspaceId)).toEqual(members);
    expect((await invitationRow(database(), id)).status).toBe("pending");
    expect(await harness.auditActions(workspaceId)).not.toContain("member.joined");

    source.grant("members.invite", true);
    const accepted = await acceptAs(world, invitee, token);
    expect(accepted.status).toBe(200);
    expect((await harness.rolesOf(workspaceId))[invitee.account.id]).toBe("member");
    expect(await harness.auditActions(workspaceId)).toContain("member.joined");
  }, TEST_TIMEOUT_MS);

  it("answers 403 entitlement_required for a new account and creates neither the account nor the membership", async () => {
    const { source, world, workspaceId, admin } = await serveWorkspace();
    const email = freshAddress();
    const id = await createInvitation(world, admin, email);
    const token = await linkOf(world, admin, id);
    const members = await harness.rolesOf(workspaceId);
    source.deny("members.invite");

    const refused = await signup(world, token);
    expect(refused.status).toBe(403);
    expect(await problemOf(refused)).toMatchObject({ code: "entitlement_required", entitlement: "members.invite", upgradeAvailable: false });
    expect(await accountCount(email)).toBe(0);
    expect(await harness.rolesOf(workspaceId)).toEqual(members);
    expect((await invitationRow(database(), id)).status).toBe("pending");

    source.grant("members.invite", true);
    expect((await signup(world, token)).status).toBe(201);
    expect(await accountCount(email)).toBe(1);
  }, TEST_TIMEOUT_MS);

  it("refuses with an error, and creates no membership, when the source cannot answer", async () => {
    const { source, world, workspaceId, admin } = await serveWorkspace();
    const invitee = await harness.person(world);
    const token = await linkOf(world, admin, await createInvitation(world, admin, invitee.account.email));
    const members = await harness.rolesOf(workspaceId);
    source.forWorkspace = (): Promise<WorkspaceEntitlementGrant> => Promise.reject(new Error("the source is down"));

    expect((await acceptAs(world, invitee, token)).status).toBe(500);
    expect(await harness.rolesOf(workspaceId)).toEqual(members);
  }, TEST_TIMEOUT_MS);

  it("still answers 410 token_expired for a token that is not a pending invitation's, whatever the source holds", async () => {
    const { source, world } = await serveWorkspace();
    source.deny("members.invite");
    const invitee = await harness.person(world);
    const token = "A".repeat(43);
    expect((await acceptAs(world, invitee, token)).status).toBe(410);
    expect((await signup(world, token)).status).toBe(410);
  }, TEST_TIMEOUT_MS);
});

describe("the owner invitation an instance admin issues (acceptInvitation)", () => {
  const WORKSPACES = "/api/v1/instance/workspaces";

  // No mail is configured, so the creation returns the link of the owner invitation.
  async function waitingWorkspace(world: World, cookie: string, ownerEmail: string): Promise<{ id: string; token: string }> {
    const created = await send(world, "POST", WORKSPACES, { cookie }, { name: "Waiting", ownerEmail });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { id: string; ownerInvitation: { link: string } };
    const token = new URL(body.ownerInvitation.link).pathname.split("/").at(-1);
    expect(token).toBeDefined();
    return { id: body.id, token: token ?? "" };
  }

  function serveWithoutMail(source: LimitedEntitlementSource): World {
    return harness.serve({
      entitlementSource: source,
      env: { RATE_LIMIT_TOKEN_REDEEM_IP: "10000/hour", RATE_LIMIT_TOKEN_REDEEM_ACCOUNT: "10000/hour", RATE_LIMIT_RESET_IP: "10000/hour", RATE_LIMIT_RESET_EMAIL: "10000/hour" },
    });
  }

  it("is accepted by the signed-in account while members.invite is withheld, and the workspace gets its owner", async () => {
    const source = new LimitedEntitlementSource().deny("members.invite");
    const world = serveWithoutMail(source);
    const root = await signInAdmin(database(), world);
    const owner = await harness.person(world);
    const { id, token } = await waitingWorkspace(world, root.cookie, owner.account.email);

    const accepted = await acceptAs(world, owner, token);

    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ workspaceId: id, role: "owner" });
    expect(await harness.rolesOf(id)).toEqual({ [owner.account.id]: "owner" });
  }, TEST_TIMEOUT_MS);

  it("is accepted with a display name and a password while members.invite is withheld, and creates the account that owns the workspace", async () => {
    const source = new LimitedEntitlementSource().deny("members.invite");
    const world = serveWithoutMail(source);
    const root = await signInAdmin(database(), world);
    const email = freshAddress("owner");
    const { id, token } = await waitingWorkspace(world, root.cookie, email);

    const accepted = await signup(world, token);

    expect(accepted.status).toBe(201);
    expect(await accepted.json()).toEqual({ workspaceId: id, role: "owner" });
    expect(await accountCount(email)).toBe(1);
    expect(Object.values(await harness.rolesOf(id))).toEqual(["owner"]);
  }, TEST_TIMEOUT_MS);

  it("does not exempt a member's invitation to the same workspace: its owner is seated while members.invite is withheld, and a member invited there afterwards is refused", async () => {
    const source = new LimitedEntitlementSource().deny("members.invite");
    const world = serveWithoutMail(source);
    const root = await signInAdmin(database(), world);
    const owner = await harness.person(world);
    const invitee = await harness.person(world);
    const waiting = await waitingWorkspace(world, root.cookie, owner.account.email);

    const seated = await acceptAs(world, owner, waiting.token);
    expect(seated.status).toBe(200);
    expect(await seated.json()).toEqual({ workspaceId: waiting.id, role: "owner" });

    // The owner can invite only while the entitlement is held; the invitation is then accepted once it is withheld again.
    source.grant("members.invite", true);
    await bumpVersion(waiting.id);
    const memberToken = await linkOf(world, owner, await createInvitation(world, owner, invitee.account.email));
    const members = await harness.rolesOf(waiting.id);
    source.deny("members.invite");
    await bumpVersion(waiting.id);

    const refused = await acceptAs(world, invitee, memberToken);
    expect(refused.status).toBe(403);
    expect(await problemOf(refused)).toMatchObject({ code: "entitlement_required", entitlement: "members.invite" });
    expect(await harness.rolesOf(waiting.id)).toEqual(members);
    expect((await harness.rolesOf(waiting.id))[invitee.account.id]).toBeUndefined();
  }, TEST_TIMEOUT_MS);

  it("still counts against the seat limit: the exemption covers members.invite only", async () => {
    const source = new LimitedEntitlementSource().deny("members.invite").grant("seats.max", 0);
    const world = serveWithoutMail(source);
    const root = await signInAdmin(database(), world);
    const owner = await harness.person(world);
    const { id, token } = await waitingWorkspace(world, root.cookie, owner.account.email);

    const refused = await acceptAs(world, owner, token);

    expect(refused.status).toBe(422);
    expect((await problemOf(refused)).code).toBe("seat_limit_reached");
    expect(await harness.rolesOf(id)).toEqual({});
  }, TEST_TIMEOUT_MS);

  it("cannot be made by a workspace member: POST /invitations refuses the owner role and writes no invitation", async () => {
    const world = serveWithoutMail(new LimitedEntitlementSource());
    const { workspaceId, admin } = await workspaceWithAdmin(harness, world);

    const refused = await send(world, "POST", INVITATIONS, { cookie: admin.cookie }, { email: freshAddress(), role: "owner" });

    expect(refused.status).toBe(422);
    expect(await invitationCount(workspaceId)).toBe(0);
  }, TEST_TIMEOUT_MS);
});
