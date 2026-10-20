import { describe, expect, it } from "vitest";
import {
  acceptInvitationWithAccount,
  generateCredentialToken,
  type InvitationSignupAsk,
  type InvitationSignupRecords,
  type InvitationSignupResult,
  type InvitationSignupStore,
  type NewAccountAcceptance,
} from "../../src/index.ts";

const WORKSPACE = "0192f3a0-cccc-7000-8000-000000000001";
const INVITATION = "0192f3a0-cccc-7000-8000-000000000002";

function ids(): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `0192f3a0-aaaa-7000-8000-${next.toString(16).padStart(12, "0")}`;
  };
}

function world(result: InvitationSignupResult) {
  const asked: NewAccountAcceptance[] = [];
  const written: InvitationSignupRecords[] = [];
  const store: InvitationSignupStore = {
    acceptWithNewAccount(acceptance) {
      asked.push(acceptance);
      if (result.kind === "accepted") {
        written.push(acceptance.onAccepted({ workspaceId: result.workspaceId, role: result.role }));
      }
      return Promise.resolve(result);
    },
  };
  return { asked, written, dependencies: { store, newId: ids() } };
}

function ask(token: string): InvitationSignupAsk {
  return {
    token,
    displayName: "Grace Hopper",
    passwordHash: "$argon2id$stub",
    locale: "de",
    seatLimit: 3,
    session: { id: "0192f3a0-dddd-7000-8000-000000000001", tokenHash: Buffer.alloc(32, 1), replacedTokenHash: null, ipPrefix: "203.0.0.0/16", userAgent: "tests" },
  };
}

describe("accepting an invitation with registration fields", () => {
  it("hands the store the token's hash, a generated account identifier and the fields, and prepares the records of the transaction from the workspace and role it answers", async () => {
    const token = generateCredentialToken();
    const w = world({ kind: "accepted", workspaceId: WORKSPACE, invitationId: INVITATION, role: "admin" });

    const outcome = await acceptInvitationWithAccount(w.dependencies, ask(token.value));

    expect(outcome).toEqual({ kind: "accepted", workspaceId: WORKSPACE, invitationId: INVITATION, role: "admin" });
    expect(w.asked).toHaveLength(1);
    const accepted = w.asked[0];
    expect(accepted).toMatchObject({ tokenHash: token.hash, displayName: "Grace Hopper", passwordHash: "$argon2id$stub", locale: "de", seatLimit: 3 });
    const accountId = accepted?.accountId ?? "";
    expect(accountId).toMatch(/^0192f3a0-aaaa-7000-8000-/);
    const records = w.written[0];
    expect(records?.audit).toHaveLength(1);
    expect(records?.audit[0]).toMatchObject({
      action: "member.joined",
      workspaceId: WORKSPACE,
      actorType: "account",
      actorAccountId: accountId,
      actorLabel: "Grace Hopper",
      entityType: "member",
      entityId: accountId,
      metadata: { role: "admin" },
      ipPrefix: "203.0.0.0/16",
    });
    expect(records?.events.map((event) => ({ name: event.name, payload: event.payload }))).toEqual([
      { name: "account.created", payload: { accountId, path: "invitation" } },
      { name: "member.joined", payload: { workspaceId: WORKSPACE, accountId, role: "admin" } },
    ]);
  });

  it("passes every refusal on and prepares no record for it", async () => {
    const token = generateCredentialToken();
    for (const result of [{ kind: "gone" }, { kind: "seat_limit_reached" }, { kind: "email_taken" }] as const) {
      const w = world(result);

      expect(await acceptInvitationWithAccount(w.dependencies, ask(token.value))).toEqual(result);
      expect(w.written).toEqual([]);
    }
  });

  it("answers gone without asking the database for a text that cannot be a token", async () => {
    const w = world({ kind: "email_taken" });

    for (const token of ["", "short", "!".repeat(43)]) {
      expect(await acceptInvitationWithAccount(w.dependencies, ask(token))).toEqual({ kind: "gone" });
    }
    expect(w.asked).toEqual([]);
  });
});
