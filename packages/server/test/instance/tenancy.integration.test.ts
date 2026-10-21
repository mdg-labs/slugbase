import { classifyOperations, loadOpenApiDocument } from "@slugbase/testing/tenancy";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionRows, setActiveWorkspace } from "../auth/support.ts";
import type { RequestParts } from "../contract/walker.ts";
import { HOOK_TIMEOUT_MS, workspaceHarness, type Person, type World } from "../workspaces/support.ts";
import { callOperation, callParts, codeOf, partsOf, signInAdmin, workspaceContent, type Principal } from "./support.ts";

// An instance admin is no member of any workspace (doc 02 section 11, doc 10 T1, Q44): the flag opens the /instance operations and nothing in
// a workspace. The matrix in `contract/contract.integration.test.ts` shows it over the stub principals of the contract tests and
// `packages/testing` in RLS-only mode; this is the same boundary over the production tenant resolver and real sign-ins, for every
// tenant-scoped operation of the committed document (read when the suite runs, so an added one is walked with no edit here). The first group
// signs the admin in with no active workspace and sends ids no workspace holds; the second seeds a workspace with members and an invitation,
// points the admin's session at it, and sends the ids of those rows.

const database = useTestDatabase();
const harness = workspaceHarness(database);

beforeAll(() => harness.start(), HOOK_TIMEOUT_MS);
afterAll(() => harness.stop());

const tenantScoped = classifyOperations(loadOpenApiDocument()).operations.filter((operation) => operation.kind === "tenant-scoped");

describe("an instance admin with a second factor who belongs to no workspace and has none active", () => {
  let world: World;
  let admin: Principal;

  beforeAll(async () => {
    world = harness.serve();
    admin = await signInAdmin(database(), world);
  }, HOOK_TIMEOUT_MS);

  it("walks the tenant-scoped operations of the document, not an empty list", () => {
    expect(tenantScoped.length).toBeGreaterThanOrEqual(16);
  });

  it("is answered 404 not_found by each of them, whatever its policy, for the example ids that no workspace holds", async () => {
    for (const operation of tenantScoped) {
      for (const foreign of [false, true]) {
        const response = await callOperation(world, operation, admin.cookie, {}, foreign);
        expect([operation.operationId, response.status, await codeOf(response)], `${operation.operationId} (${operation.policy})`).toEqual([operation.operationId, 404, "not_found"]);
      }
    }
  });
});

const INVITEE = "tenancy-suite-invitee@example.test";

describe("an instance admin with a second factor whose session points at a workspace they are no member of", () => {
  let world: World;
  let admin: Principal;
  let owner: Person;
  let member: Person;
  let workspaceId: string;
  let invitationId: string;

  beforeAll(async () => {
    world = harness.serve();
    owner = await harness.person(world);
    member = await harness.person(world);
    ({ workspaceId } = await harness.workspaceOf([
      { person: owner, role: "owner" },
      { person: member, role: "member" },
    ]));
    invitationId = "0192f3a0-cccc-7000-8000-0000000000a1";
    await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      await tx`
        INSERT INTO workspace_invitations (id, workspace_id, email, role, token_hash, expires_at)
        VALUES (${invitationId}, ${workspaceId}, ${INVITEE}, 'member', sha256('tenancy-suite-invitation'::bytea), now() + interval '7 days')`;
    });
    admin = await signInAdmin(database(), world);
    // The session names the workspace as its active one, the way a forged or stale value would; the admin has no membership in it.
    for (const session of await sessionRows(database(), admin.accountId)) {
      await setActiveWorkspace(database(), session.id, workspaceId);
    }
  }, HOOK_TIMEOUT_MS);

  /** The request that names the rows of the seeded workspace, for the operations that take any, and the operation's own request otherwise. */
  const realParts = (operationId: string, own: RequestParts): RequestParts => {
    switch (operationId) {
      case "updateMember":
        return { path: { accountId: member.account.id }, body: { role: "admin" } };
      case "removeMember":
        return { path: { accountId: member.account.id }, body: { content: "transfer", transferTo: owner.account.id } };
      case "leaveWorkspace":
        return { body: { content: "transfer", transferTo: owner.account.id } };
      case "transferWorkspaceOwnership":
        return { body: { accountId: member.account.id, demoteSelf: false } };
      case "createInvitation":
        return { body: { email: "tenancy-suite-second-invitee@example.test", role: "member" } };
      case "resendInvitation":
      case "createInvitationLink":
      case "revokeInvitation":
        return { path: { id: invitationId } };
      default:
        return own;
    }
  };

  it("is no member of the workspace its session names", async () => {
    expect(await harness.rolesOf(workspaceId)).toEqual({ [owner.account.id]: "owner", [member.account.id]: "member" });
  });

  it("is answered 404 not_found by each tenant-scoped operation naming the real members and invitation of that workspace, which is left as it was", async () => {
    const before = await workspaceContent(database(), workspaceId);
    for (const operation of tenantScoped) {
      const response = await callParts(world, operation, realParts(operation.operationId, partsOf(operation)), admin.cookie);
      expect([operation.operationId, response.status, await codeOf(response)], `${operation.operationId} (${operation.policy})`).toEqual([operation.operationId, 404, "not_found"]);
    }
    expect(await workspaceContent(database(), workspaceId)).toBe(before);
    expect(await harness.rolesOf(workspaceId)).toEqual({ [owner.account.id]: "owner", [member.account.id]: "member" });
  });

  it("answers a member of the workspace 200 for listMembers, so that read is not refused for the workspace itself", async () => {
    // Control for the listMembers read only: the workspace's own member, sending that request, is answered 200.
    const response = await callParts(world, { method: "get", path: "/api/v1/members" }, {}, member.cookie);
    expect(response.status).toBe(200);
    const listed = (await response.json()) as { items?: { accountId?: string }[] };
    expect((listed.items ?? []).map((item) => item.accountId).sort()).toEqual([owner.account.id, member.account.id].sort());
  });
});
