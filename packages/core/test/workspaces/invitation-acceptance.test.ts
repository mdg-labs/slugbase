import { describe, expect, it } from "vitest";
import {
  acceptInvitation,
  createAuditWriter,
  generateCredentialToken,
  inspectInvitation,
  type AuditRecord,
  type AuditStore,
  type DomainEvent,
  type InvitationAcceptAsk,
  type InvitationAcceptResult,
  type InvitationAcceptStore,
  type InvitationInspectStore,
  type InvitationPreview,
} from "../../src/index.ts";

const WORKSPACE = "0192f3a0-cccc-7000-8000-000000000001";
const INVITATION = "0192f3a0-cccc-7000-8000-000000000002";
const ACCOUNT = "0192f3a0-bbbb-7000-8000-000000000001";
const SESSION = "0192f3a0-dddd-7000-8000-000000000001";
const ACTOR = { type: "account", accountId: ACCOUNT, label: "Grace" } as const;

function ids(): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `0192f3a0-aaaa-7000-8000-${next.toString(16).padStart(12, "0")}`;
  };
}

const PREVIEW: InvitationPreview = { workspaceName: "Ada's team", inviterName: "Ada", email: "grace@example.test", role: "admin", accountExists: true };

describe("inspecting an invitation", () => {
  it("answers the preview of the pending invitation the token's hash belongs to", async () => {
    const token = generateCredentialToken();
    const asked: Buffer[] = [];
    const store: InvitationInspectStore = {
      inspectInvitation(tokenHash) {
        asked.push(tokenHash);
        return Promise.resolve(PREVIEW);
      },
    };

    expect(await inspectInvitation({ store }, { token: token.value })).toEqual({ kind: "inspected", preview: PREVIEW });
    expect(asked).toEqual([token.hash]);
  });

  it("answers gone for a token no pending invitation holds, and reads nothing for a text that cannot be a token", async () => {
    const asked: Buffer[] = [];
    const store: InvitationInspectStore = {
      inspectInvitation(tokenHash) {
        asked.push(tokenHash);
        return Promise.resolve(undefined);
      },
    };

    expect(await inspectInvitation({ store }, { token: generateCredentialToken().value })).toEqual({ kind: "gone" });
    expect(asked).toHaveLength(1);
    for (const token of ["", "short", `${generateCredentialToken().value}A`, "!".repeat(43)]) {
      expect(await inspectInvitation({ store }, { token })).toEqual({ kind: "gone" });
    }
    expect(asked).toHaveLength(1);
  });
});

interface WorldOptions {
  readonly result?: InvitationAcceptResult;
  readonly activates?: boolean;
  readonly auditFails?: boolean;
}

/** The stores of one transaction: what they were asked for, in order. */
function world({ result = { kind: "accepted", workspaceId: WORKSPACE, invitationId: INVITATION, role: "admin" }, activates = true, auditFails = false }: WorldOptions = {}) {
  const log: string[] = [];
  const accepted: { tokenHash: Buffer; seatLimit: number | null }[] = [];
  const events: DomainEvent<"member.joined">[] = [];
  const audits: AuditRecord[] = [];
  const activations: { sessionId: string; workspaceId: string }[] = [];
  const store: InvitationAcceptStore = {
    accept(tokenHash, seatLimit) {
      log.push("accept");
      accepted.push({ tokenHash, seatLimit });
      return Promise.resolve(result);
    },
    queueEvents(queued) {
      log.push("events");
      events.push(...queued);
      return Promise.resolve();
    },
    activate(sessionId, workspaceId) {
      log.push("activate");
      activations.push({ sessionId, workspaceId });
      return Promise.resolve(activates);
    },
  };
  const auditStore: AuditStore = {
    insert(record) {
      log.push("audit");
      if (auditFails) {
        return Promise.reject(new Error("the database refused"));
      }
      audits.push(record);
      return Promise.resolve();
    },
  };
  return { log, accepted, events, audits, activations, dependencies: { store, audit: createAuditWriter({ store: auditStore, newId: ids() }), newId: ids() } };
}

function ask(token: string, overrides: Partial<InvitationAcceptAsk> = {}): InvitationAcceptAsk {
  return { token, actor: ACTOR, sessionId: SESSION, seatLimit: null, ipPrefix: "203.0.0.0/16", ...overrides };
}

describe("accepting an invitation", () => {
  it("asks the database operation for the token's hash with the seat limit, then records member.joined as an audit event and a domain event and moves the session", async () => {
    const token = generateCredentialToken();
    const w = world();

    const outcome = await acceptInvitation(w.dependencies, ask(token.value, { seatLimit: 5 }));

    expect(outcome).toEqual({ kind: "accepted", workspaceId: WORKSPACE, invitationId: INVITATION, role: "admin" });
    expect(w.accepted).toEqual([{ tokenHash: token.hash, seatLimit: 5 }]);
    expect(w.log).toEqual(["accept", "audit", "events", "activate"]);
    expect(w.audits).toHaveLength(1);
    expect(w.audits[0]).toMatchObject({
      action: "member.joined",
      workspaceId: WORKSPACE,
      actorType: "account",
      actorAccountId: ACCOUNT,
      entityType: "member",
      entityId: ACCOUNT,
      metadata: { role: "admin" },
      ipPrefix: "203.0.0.0/16",
    });
    expect(w.events).toHaveLength(1);
    expect(w.events[0]).toMatchObject({ name: "member.joined", payload: { workspaceId: WORKSPACE, accountId: ACCOUNT, role: "admin" } });
    expect(w.activations).toEqual([{ sessionId: SESSION, workspaceId: WORKSPACE }]);
  });

  it("writes nothing for any refusal: no audit event, no domain event and no move of the session", async () => {
    const token = generateCredentialToken();
    for (const result of [{ kind: "gone" }, { kind: "email_mismatch" }, { kind: "already_member" }, { kind: "seat_limit_reached" }] as const) {
      const w = world({ result });

      expect(await acceptInvitation(w.dependencies, ask(token.value))).toEqual(result);
      expect(w.log).toEqual(["accept"]);
    }
  });

  it("answers gone without touching the database for a text that cannot be a token", async () => {
    const w = world();

    for (const token of ["", "short", "!".repeat(43)]) {
      expect(await acceptInvitation(w.dependencies, ask(token))).toEqual({ kind: "gone" });
    }
    expect(w.log).toEqual([]);
  });

  it("rejects, so the transaction does not commit, when the audit event cannot be written or the session cannot be moved", async () => {
    const token = generateCredentialToken();

    await expect(acceptInvitation(world({ auditFails: true }).dependencies, ask(token.value))).rejects.toThrow("the database refused");
    await expect(acceptInvitation(world({ activates: false }).dependencies, ask(token.value))).rejects.toThrow(/could not be pointed at the workspace/);
  });
});
