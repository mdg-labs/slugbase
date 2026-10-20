import { describe, expect, it } from "vitest";
import {
  acceptInvitationWithIdentity,
  type IdentityAcceptance,
  type InvitationIdentityAsk,
  type InvitationIdentityRecords,
  type InvitationIdentityResult,
  type InvitationIdentityStore,
} from "../../src/index.ts";

const WORKSPACE = "0192f3a0-cccc-7000-8000-000000000001";
const INVITATION = "0192f3a0-cccc-7000-8000-000000000002";
const ACCOUNT = "0192f3a0-cccc-7000-8000-000000000003";

function ids(): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `0192f3a0-aaaa-7000-8000-${next.toString(16).padStart(12, "0")}`;
  };
}

function world(result: InvitationIdentityResult, accepted: { accountId?: string; displayName?: string; created?: boolean } = {}) {
  const asked: IdentityAcceptance[] = [];
  const written: InvitationIdentityRecords[] = [];
  const store: InvitationIdentityStore = {
    acceptWithIdentity(acceptance) {
      asked.push(acceptance);
      if (result.kind === "accepted") {
        written.push(
          acceptance.onAccepted({
            workspaceId: result.workspaceId,
            role: result.role,
            accountId: accepted.accountId ?? result.accountId,
            displayName: accepted.displayName ?? "Grace Hopper",
            created: accepted.created ?? result.created,
          }),
        );
      }
      return Promise.resolve(result);
    },
  };
  return { asked, written, dependencies: { store, newId: ids() } };
}

function ask(overrides: Partial<InvitationIdentityAsk> = {}): InvitationIdentityAsk {
  return {
    tokenHash: Buffer.alloc(32, 7),
    provider: "idp",
    subject: "subject-1",
    email: "grace@example.test",
    displayName: "Grace Hopper",
    locale: "de",
    mayCreate: true,
    seatLimit: 3,
    session: { id: "0192f3a0-dddd-7000-8000-000000000001", tokenHash: Buffer.alloc(32, 1), replacedTokenHash: null, ipPrefix: "203.0.0.0/16", userAgent: "tests" },
    ...overrides,
  };
}

describe("accepting an invitation through a provider", () => {
  it("hands the store the hash of the token, the identity and the address the provider asserted, and generated identifiers for the identity and the account", async () => {
    const w = world({ kind: "accepted", workspaceId: WORKSPACE, invitationId: INVITATION, role: "admin", accountId: ACCOUNT, created: true });

    const outcome = await acceptInvitationWithIdentity(w.dependencies, ask());

    expect(outcome).toEqual({ kind: "accepted", workspaceId: WORKSPACE, invitationId: INVITATION, role: "admin", accountId: ACCOUNT, created: true });
    expect(w.asked).toHaveLength(1);
    const acceptance = w.asked[0];
    expect(acceptance).toMatchObject({
      tokenHash: Buffer.alloc(32, 7),
      provider: "idp",
      subject: "subject-1",
      email: "grace@example.test",
      displayName: "Grace Hopper",
      locale: "de",
      mayCreate: true,
      seatLimit: 3,
    });
    expect(acceptance?.identityId).toMatch(/^0192f3a0-aaaa-7000-8000-/);
    expect(acceptance?.accountId).toMatch(/^0192f3a0-aaaa-7000-8000-/);
    expect(acceptance?.identityId).not.toBe(acceptance?.accountId);
  });

  it("records member.joined as an audit event and a domain event, and account.created with the path invitation only when the acceptance created the account", async () => {
    const created = world({ kind: "accepted", workspaceId: WORKSPACE, invitationId: INVITATION, role: "member", accountId: ACCOUNT, created: true });
    await acceptInvitationWithIdentity(created.dependencies, ask());
    const existing = world({ kind: "accepted", workspaceId: WORKSPACE, invitationId: INVITATION, role: "member", accountId: ACCOUNT, created: false }, { displayName: "Ada" });
    await acceptInvitationWithIdentity(existing.dependencies, ask());

    expect(created.written[0]?.events.map((event) => ({ name: event.name, payload: event.payload }))).toEqual([
      { name: "account.created", payload: { accountId: ACCOUNT, path: "invitation" } },
      { name: "member.joined", payload: { workspaceId: WORKSPACE, accountId: ACCOUNT, role: "member" } },
    ]);
    expect(existing.written[0]?.events.map((event) => event.name)).toEqual(["member.joined"]);
    expect(created.written[0]?.audit[0]).toMatchObject({
      action: "member.joined",
      workspaceId: WORKSPACE,
      actorType: "account",
      actorAccountId: ACCOUNT,
      actorLabel: "Grace Hopper",
      entityType: "member",
      entityId: ACCOUNT,
      metadata: { role: "member" },
      ipPrefix: "203.0.0.0/16",
    });
    expect(existing.written[0]?.audit[0]).toMatchObject({ actorAccountId: ACCOUNT, actorLabel: "Ada" });
  });

  it("passes every refusal on and prepares no record for it", async () => {
    for (const kind of ["gone", "email_mismatch", "already_member", "seat_limit_reached", "email_taken", "not_permitted", "identity_in_use"] as const) {
      const w = world({ kind });

      expect(await acceptInvitationWithIdentity(w.dependencies, ask())).toEqual({ kind });
      expect(w.written).toEqual([]);
    }
  });

  it("leaves whether an account may be created to the caller: the flag reaches the store as it was given", async () => {
    for (const mayCreate of [true, false]) {
      const w = world({ kind: "not_permitted" });

      await acceptInvitationWithIdentity(w.dependencies, ask({ mayCreate }));

      expect(w.asked[0]?.mayCreate).toBe(mayCreate);
    }
  });
});
