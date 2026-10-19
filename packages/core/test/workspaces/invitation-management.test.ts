import { describe, expect, it } from "vitest";
import {
  INVITATION_TTL_SECONDS,
  createAuditWriter,
  createInvitationLink,
  hashCredentialToken,
  invitationLink,
  listInvitations,
  resendInvitation,
  revokeInvitation,
  type AuditRecord,
  type AuditStore,
  type InvitationActionAsk,
  type InvitationListing,
  type InvitationManagementStore,
  type InvitationRecord,
  type InvitationRenewal,
  type InvitationRevocation,
  type WorkspaceRole,
} from "../../src/index.ts";

// Listing, resending, linking and revoking a pending invitation (doc 04 section 10.5, doc 02 section 3.4, doc 10
// T4, T7 and T19): an admin or an owner only, before anything is read or written; a resend and a link replace the
// token hash, so the earlier token has no row to match, and only the link's token is in the outcome; each action
// is recorded once, without the address or the token; a revoked invitation is answered the same way again and
// writes no second event; and a failed audit write rejects so the caller's transaction does not commit.

const WORKSPACE = "0192f3a0-cccc-7000-8000-000000000001";
const INVITATION_ID = "0192f3a0-dddd-7000-8000-000000000001";
const ACTOR = { type: "account", accountId: "0192f3a0-bbbb-7000-8000-000000000001", label: "Ada" } as const;

const RECORD: InvitationRecord = {
  id: INVITATION_ID,
  email: "grace@example.test",
  role: "admin",
  teamIds: [],
  status: "pending",
  invitedBy: ACTOR.accountId,
  expiresAt: new Date("2026-10-26T12:00:00.000Z"),
  createdAt: new Date("2026-10-19T12:00:00.000Z"),
};

interface WorldOptions {
  actorRole?: WorkspaceRole | "none";
  /** Whether the workspace has the pending invitation. */
  present?: boolean;
  revocation?: InvitationRevocation["kind"];
  inviteeLocale?: string | undefined;
  auditFails?: boolean;
  listed?: readonly InvitationListing[];
}

function world({ actorRole = "admin", present = true, revocation = "revoked", inviteeLocale, auditFails = false, listed = [] }: WorldOptions = {}) {
  const log: string[] = [];
  const renewals: InvitationRenewal[] = [];
  const audits: AuditRecord[] = [];
  const store: InvitationManagementStore = {
    actorRole() {
      log.push("actorRole");
      return Promise.resolve(actorRole === "none" ? undefined : actorRole);
    },
    pending() {
      log.push("pending");
      return Promise.resolve(present ? RECORD : undefined);
    },
    listPending(afterId, limit) {
      log.push(`listPending ${String(afterId)} ${String(limit)}`);
      return Promise.resolve(listed);
    },
    renew(_id, renewal) {
      log.push("renew");
      renewals.push(renewal);
      return Promise.resolve(present ? RECORD : undefined);
    },
    revoke() {
      log.push("revoke");
      return Promise.resolve(revocation === "revoked" ? { kind: "revoked", invitation: { ...RECORD, status: "revoked" } } : { kind: revocation });
    },
    inviteeLocale() {
      log.push("inviteeLocale");
      return Promise.resolve(inviteeLocale);
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
  return { log, renewals, audits, dependencies: { store, audit: createAuditWriter({ store: auditStore, newId: () => "0192f3a0-aaaa-7000-8000-000000000001" }), ttlSeconds: INVITATION_TTL_SECONDS } };
}

function ask(): InvitationActionAsk {
  return { workspaceId: WORKSPACE, actor: ACTOR, actorLocale: "en", invitationId: INVITATION_ID, ipPrefix: "203.0.0.0/16" };
}

const NOT_MANAGERS: readonly (WorkspaceRole | "none")[] = ["member", "none"];

describe("listInvitations", () => {
  it.each(NOT_MANAGERS)("refuses an account whose role in the workspace is %s before it reads the list", async (actorRole) => {
    const { dependencies, log } = world({ actorRole });

    expect(await listInvitations(dependencies, { afterId: null, limit: 51 })).toEqual({ kind: "forbidden" });

    expect(log).toEqual(["actorRole"]);
  });

  it.each<WorkspaceRole>(["admin", "owner"])("lists for an %s, from the cursor and up to the limit it was asked", async (actorRole) => {
    const listing: InvitationListing = { ...RECORD, expired: true };
    const { dependencies, log } = world({ actorRole, listed: [listing] });

    expect(await listInvitations(dependencies, { afterId: INVITATION_ID, limit: 51 })).toEqual({ kind: "listed", invitations: [listing] });

    expect(log).toEqual(["actorRole", `listPending ${INVITATION_ID} 51`]);
  });
});

describe("resendInvitation", () => {
  it.each(NOT_MANAGERS)("refuses an account whose role in the workspace is %s and writes nothing", async (actorRole) => {
    const { dependencies, log, renewals, audits } = world({ actorRole });

    expect(await resendInvitation(dependencies, ask())).toEqual({ kind: "forbidden" });

    expect(log).toEqual(["actorRole"]);
    expect(renewals).toEqual([]);
    expect(audits).toEqual([]);
  });

  it("answers not found for an invitation the workspace does not hold as pending, and records nothing", async () => {
    const { dependencies, audits } = world({ present: false });

    expect(await resendInvitation(dependencies, ask())).toEqual({ kind: "not_found" });

    expect(audits).toEqual([]);
  });

  it("stores the hash of a token nobody holds with the full lifetime, records invitation.resent with the role and no address, and writes the mail in the invitee's language", async () => {
    const { dependencies, renewals, audits } = world({ inviteeLocale: "de" });

    const outcome = await resendInvitation(dependencies, ask());

    expect(outcome).toEqual({ kind: "resent", invitation: RECORD, locale: "de" });
    expect(renewals).toHaveLength(1);
    expect(renewals[0]?.tokenHash).toHaveLength(32);
    expect(renewals[0]?.ttlSeconds).toBe(INVITATION_TTL_SECONDS);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "invitation.resent", workspaceId: WORKSPACE, entityType: "invitation", entityId: INVITATION_ID, metadata: { role: "admin" } });
    expect(JSON.stringify(audits)).not.toContain("grace@example.test");
  });

  it("falls back to the language of the account that asks when no account holds the address", async () => {
    expect(await resendInvitation(world({ inviteeLocale: undefined }).dependencies, { ...ask(), actorLocale: "de" })).toMatchObject({ locale: "de" });
  });

  it("makes a different token each time, so a second resend ends the first one's link", async () => {
    const { dependencies, renewals } = world();

    await resendInvitation(dependencies, ask());
    await resendInvitation(dependencies, ask());

    expect(renewals[0]?.tokenHash.equals(renewals[1]?.tokenHash ?? Buffer.alloc(0))).toBe(false);
  });

  it("rejects when the audit write fails, so the caller's transaction does not commit the new token", async () => {
    await expect(resendInvitation(world({ auditFails: true }).dependencies, ask())).rejects.toThrow("the database refused");
  });
});

describe("createInvitationLink", () => {
  it.each(NOT_MANAGERS)("refuses an account whose role in the workspace is %s and makes no token", async (actorRole) => {
    const { dependencies, log, renewals } = world({ actorRole });

    expect(await createInvitationLink(dependencies, ask())).toEqual({ kind: "forbidden" });

    expect(log).toEqual(["actorRole"]);
    expect(renewals).toEqual([]);
  });

  it("answers not found for an invitation the workspace does not hold as pending, with no token in the outcome", async () => {
    const outcome = await createInvitationLink(world({ present: false }).dependencies, ask());

    expect(outcome).toEqual({ kind: "not_found" });
  });

  it("stores only the hash of the token it returns, and records invitation.link_created without the token or the address", async () => {
    const { dependencies, renewals, audits } = world();

    const outcome = await createInvitationLink(dependencies, ask());

    if (outcome.kind !== "linked") {
      throw new Error(`expected a link, got ${outcome.kind}`);
    }
    expect(outcome.invitation).toEqual(RECORD);
    expect(renewals[0]?.tokenHash.equals(hashCredentialToken(outcome.token) ?? Buffer.alloc(0))).toBe(true);
    expect(renewals[0]?.ttlSeconds).toBe(INVITATION_TTL_SECONDS);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "invitation.link_created", entityId: INVITATION_ID, metadata: { role: "admin" } });
    expect(JSON.stringify(audits)).not.toContain(outcome.token);
    expect(JSON.stringify(audits)).not.toContain("grace@example.test");
  });

  it("makes a new token each time, so the earlier link has no hash to match", async () => {
    const { dependencies, renewals } = world();

    const first = await createInvitationLink(dependencies, ask());
    const second = await createInvitationLink(dependencies, ask());

    expect(first.kind === "linked" && second.kind === "linked" && first.token !== second.token).toBe(true);
    expect(renewals[0]?.tokenHash.equals(renewals[1]?.tokenHash ?? Buffer.alloc(0))).toBe(false);
  });

  it("rejects when the audit write fails, so no link is returned for a token that was not committed", async () => {
    await expect(createInvitationLink(world({ auditFails: true }).dependencies, ask())).rejects.toThrow("the database refused");
  });
});

describe("revokeInvitation", () => {
  it.each(NOT_MANAGERS)("refuses an account whose role in the workspace is %s and revokes nothing", async (actorRole) => {
    const { dependencies, log, audits } = world({ actorRole });

    expect(await revokeInvitation(dependencies, ask())).toEqual({ kind: "forbidden" });

    expect(log).toEqual(["actorRole"]);
    expect(audits).toEqual([]);
  });

  it("revokes and records invitation.revoked with the role and no address", async () => {
    const { dependencies, audits } = world();

    expect(await revokeInvitation(dependencies, ask())).toEqual({ kind: "revoked" });

    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "invitation.revoked", entityType: "invitation", entityId: INVITATION_ID, metadata: { role: "admin" } });
    expect(JSON.stringify(audits)).not.toContain("grace@example.test");
  });

  it("answers a revoked invitation the same way and records no second event", async () => {
    const { dependencies, audits } = world({ revocation: "already_revoked" });

    expect(await revokeInvitation(dependencies, ask())).toEqual({ kind: "already_revoked" });

    expect(audits).toEqual([]);
  });

  it("answers not found for an invitation the workspace does not hold, and records nothing", async () => {
    const { dependencies, audits } = world({ revocation: "not_found" });

    expect(await revokeInvitation(dependencies, ask())).toEqual({ kind: "not_found" });

    expect(audits).toEqual([]);
  });

  it("rejects when the audit write fails, so the caller's transaction does not commit the revocation", async () => {
    await expect(revokeInvitation(world({ auditFails: true }).dependencies, ask())).rejects.toThrow("the database refused");
  });
});

describe("invitationLink", () => {
  it("is the invitation page of the deployment's origin followed by the token, whatever path or slash the configured origin has", () => {
    expect(invitationLink("https://slugbase.example.test", "T0ken")).toBe("https://slugbase.example.test/invite/T0ken");
    expect(invitationLink("https://slugbase.example.test/", "T0ken")).toBe("https://slugbase.example.test/invite/T0ken");
    expect(invitationLink("http://localhost:5173", "T0ken")).toBe("http://localhost:5173/invite/T0ken");
  });
});
