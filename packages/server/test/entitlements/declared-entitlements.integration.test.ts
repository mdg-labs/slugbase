import { LimitedEntitlementSource } from "@slugbase/testing";
import { loadOpenApiDocument } from "@slugbase/testing/tenancy";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readOperations, type DocumentedOperation } from "../contract/document.ts";
import { createInvitation, freshAddress, INVITATIONS, revoke, workspaceWithAdmin } from "../invitations/support.ts";
import { HOOK_TIMEOUT_MS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// The contract-driven walk of doc 04 section 1.3 for entitlements (doc 01 section 7.5, doc 10 T3 and T11): for every
// operation of openapi.json that declares an entitlement, the server answers 403 entitlement_required naming that
// entitlement while the entitlement source withholds it, and answers normally while the source grants it. An operation
// that declares none is not touched by the source. An operation that declares an entitlement and has no request here
// fails the walk, so a new declaration cannot ship untested.

const TEST_TIMEOUT_MS = 60_000;
const TEAMS = "/api/v1/teams";
const database = useTestDatabase();
const harness = workspaceHarness(database);
const declared = readOperations(loadOpenApiDocument()).operations.filter((operation) => operation.entitlement !== undefined);

beforeAll(() => harness.start(), HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await database().owner`TRUNCATE pgboss.job`;
});

afterAll(() => harness.stop());

interface Fixture {
  readonly world: World;
  readonly admin: Person;
  readonly invitationId: string;
  readonly workspaceId: string;
  readonly teamId: string;
}

/** A team of the workspace, written as the system: the operations that create one are the ones the walk withholds the entitlement from. */
async function seedTeam(workspaceId: string): Promise<string> {
  const id = crypto.randomUUID();
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`INSERT INTO teams (id, workspace_id, name) VALUES (${id}, ${workspaceId}, ${`Walked ${id}`})`;
  });
  return id;
}

/** The valid request of each operation that declares an entitlement, against the workspace of `fixture`. */
const REQUESTS: Readonly<Record<string, (fixture: Fixture) => Promise<Response>>> = {
  createInvitation: ({ world, admin }) => send(world, "POST", INVITATIONS, { cookie: admin.cookie }, { email: freshAddress(), role: "member" }),
  listInvitations: ({ world, admin }) => send(world, "GET", INVITATIONS, { cookie: admin.cookie }),
  resendInvitation: ({ world, admin, invitationId }) => send(world, "POST", `${INVITATIONS}/${invitationId}/resend`, { cookie: admin.cookie }),
  createInvitationLink: ({ world, admin, invitationId }) => send(world, "POST", `${INVITATIONS}/${invitationId}/link`, { cookie: admin.cookie }),
  listAuditEvents: ({ world, admin }) => send(world, "GET", "/api/v1/audit-events", { cookie: admin.cookie }),
  createTeam: ({ world, admin }) => send(world, "POST", TEAMS, { cookie: admin.cookie }, { name: `Team ${crypto.randomUUID()}` }),
  updateTeam: ({ world, admin, teamId }) => send(world, "PATCH", `${TEAMS}/${teamId}`, { cookie: admin.cookie }, { description: crypto.randomUUID() }),
  // Each request deletes a team of its own, since the one it deletes is gone for the next.
  deleteTeam: async ({ world, admin, workspaceId }) => send(world, "DELETE", `${TEAMS}/${await seedTeam(workspaceId)}`, { cookie: admin.cookie }),
  replaceTeamMembers: ({ world, admin, teamId }) => send(world, "PUT", `${TEAMS}/${teamId}/members`, { cookie: admin.cookie }, { accountIds: [admin.account.id] }),
};

const mail = { available: true, send: () => Promise.resolve() } as const;

/** A server over `source`, and a workspace whose admin has one pending invitation, made while the source grants everything. */
async function fixtureFor(source: LimitedEntitlementSource): Promise<Fixture & { readonly workspaceId: string }> {
  const world = harness.serve({ entitlementSource: source, mail, env: { RATE_LIMIT_RESET_IP: "10000/hour", RATE_LIMIT_RESET_EMAIL: "10000/hour" } });
  const { workspaceId, admin } = await workspaceWithAdmin(harness, world);
  const invitationId = await createInvitation(world, admin, freshAddress());
  return { world, admin, invitationId, workspaceId, teamId: await seedTeam(workspaceId) };
}

async function bumpVersion(workspaceId: string): Promise<void> {
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`UPDATE workspaces SET entitlement_version = entitlement_version + 1 WHERE id = ${workspaceId}`;
  });
}

function request(operation: DocumentedOperation, fixture: Fixture): Promise<Response> {
  const build = REQUESTS[operation.operationId];
  if (build === undefined) {
    throw new Error(`${operation.operationId} declares an entitlement and the walk has no request for it`);
  }
  return build(fixture);
}

describe("the operations that declare an entitlement", () => {
  it("are all walked", () => {
    expect(declared.map((operation) => operation.operationId).sort()).toEqual(Object.keys(REQUESTS).sort());
  });

  for (const operation of declared) {
    const key = operation.entitlement ?? "";

    it(`${operation.operationId} answers 403 entitlement_required while the source withholds ${key} and works once it grants it`, async () => {
      const source = new LimitedEntitlementSource();
      const fixture = await fixtureFor(source);

      const granted = await request(operation, fixture);
      expect(granted.status).toBeGreaterThanOrEqual(200);
      expect(granted.status).toBeLessThan(300);

      source.deny(key as Parameters<LimitedEntitlementSource["deny"]>[0]);
      await bumpVersion(fixture.workspaceId);
      const refused = await request(operation, fixture);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ code: "entitlement_required", entitlement: key, upgradeAvailable: false });

      source.grant(key as Parameters<LimitedEntitlementSource["grant"]>[0], true);
      await bumpVersion(fixture.workspaceId);
      const restored = await request(operation, fixture);
      expect(restored.status).toBeGreaterThanOrEqual(200);
      expect(restored.status).toBeLessThan(300);
    }, TEST_TIMEOUT_MS);
  }
});

describe("the operations that declare none", () => {
  it("answer as they do when the source withholds every entitlement", async () => {
    const source = new LimitedEntitlementSource();
    const fixture = await fixtureFor(source);
    for (const key of ["members.invite", "teams.manage", "audit.log", "sharing.members", "sharing.teams", "ai.suggestions"] as const) {
      source.deny(key);
    }
    await bumpVersion(fixture.workspaceId);

    const undeclared = readOperations(loadOpenApiDocument()).operations.filter((operation) => operation.entitlement === undefined);
    expect(undeclared.map((operation) => operation.operationId)).toEqual(expect.arrayContaining(["revokeInvitation", "getEntitlements", "listMembers", "listTeams", "getTeam"]));

    // Revoking an invitation is not gated (doc 01 section 7.5); the meters and the member list are not either.
    expect((await revoke(fixture.world, fixture.admin, fixture.invitationId)).status).toBe(204);
    expect((await send(fixture.world, "GET", "/api/v1/entitlements", { cookie: fixture.admin.cookie })).status).toBe(200);
    expect((await send(fixture.world, "GET", "/api/v1/members", { cookie: fixture.admin.cookie })).status).toBe(200);
    // The two reads of the teams are not gated either: the share picker lists them for every member.
    expect((await send(fixture.world, "GET", TEAMS, { cookie: fixture.admin.cookie })).status).toBe(200);
    expect((await send(fixture.world, "GET", `${TEAMS}/${fixture.teamId}`, { cookie: fixture.admin.cookie })).status).toBe(200);
  }, TEST_TIMEOUT_MS);
});
