import { describe, expect, it } from "vitest";
import {
  INVITATION_TTL_SECONDS,
  createAuditWriter,
  invitationMessage,
  inviteMember,
  type AuditRecord,
  type AuditStore,
  type InvitationAsk,
  type InvitationRecord,
  type InvitationStore,
  type NewInvitation,
  type WorkspaceRole,
} from "../../src/index.ts";

// Inviting a person (doc 02 section 3.4, doc 10 T4 and T19): an invitation never grants the owner role, is
// written by an admin or an owner only, refuses an address that belongs to a member, holds a token hash nobody
// has the token of, replaces the earlier invitation of an address, and is recorded without the address.

const WORKSPACE = "0192f3a0-cccc-7000-8000-000000000001";
const ACTOR_ACCOUNT = "0192f3a0-bbbb-7000-8000-000000000001";
const ACTOR = { type: "account", accountId: ACTOR_ACCOUNT, label: "Ada" } as const;

function ids(): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `0192f3a0-aaaa-7000-8000-${next.toString(16).padStart(12, "0")}`;
  };
}

interface WorldOptions {
  /** `none` stands for an account that is no member of the workspace. */
  actorRole?: WorkspaceRole | "none";
  memberHoldsEmail?: boolean;
  resent?: boolean;
  inviteeLocale?: string | undefined;
  auditFails?: boolean;
}

/** The stores of one transaction: what they were asked for, in order, and the rows that stay when it ends. */
function world({ actorRole = "admin", memberHoldsEmail = false, resent = false, inviteeLocale, auditFails = false }: WorldOptions = {}) {
  const log: string[] = [];
  const written: NewInvitation[] = [];
  const audits: AuditRecord[] = [];
  const store: InvitationStore = {
    actorRole() {
      log.push("actorRole");
      return Promise.resolve(actorRole === "none" ? undefined : actorRole);
    },
    memberHoldsEmail(email) {
      log.push(`memberHoldsEmail ${email}`);
      return Promise.resolve(memberHoldsEmail);
    },
    writePending(invitation) {
      log.push("writePending");
      written.push(invitation);
      const record: InvitationRecord = {
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
        teamIds: invitation.teamIds,
        status: "pending",
        invitedBy: ACTOR_ACCOUNT,
        expiresAt: new Date("2026-10-26T12:00:00.000Z"),
        createdAt: new Date("2026-10-19T12:00:00.000Z"),
      };
      return Promise.resolve({ invitation: record, resent });
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
  return {
    log,
    written,
    audits,
    dependencies: { store, audit: createAuditWriter({ store: auditStore, newId: ids() }), newId: ids(), ttlSeconds: INVITATION_TTL_SECONDS },
  };
}

function ask(overrides: Partial<InvitationAsk> = {}): InvitationAsk {
  return { workspaceId: WORKSPACE, actor: ACTOR, actorLocale: "en", email: "grace@example.test", role: "member", teamIds: [], ipPrefix: "203.0.0.0/16", ...overrides };
}

describe("inviteMember", () => {
  it("refuses the owner role and any role outside admin and member before it reads or writes anything", async () => {
    for (const role of ["owner", "OWNER", "", "superuser"]) {
      const { dependencies, log, written, audits } = world();

      expect(await inviteMember(dependencies, ask({ role }))).toEqual({ kind: "invalid_role" });

      expect(log).toEqual([]);
      expect(written).toEqual([]);
      expect(audits).toEqual([]);
    }
  });

  it("refuses teams, which have no members to join yet, and writes nothing", async () => {
    const { dependencies, log, written, audits } = world();

    expect(await inviteMember(dependencies, ask({ teamIds: ["0192f3a0-dddd-7000-8000-000000000001"] }))).toEqual({ kind: "teams_unavailable" });

    expect(log).toEqual([]);
    expect(written).toEqual([]);
    expect(audits).toEqual([]);
  });

  it.each<[WorkspaceRole | "none"]>([["member"], ["none"]])("refuses an account whose role in the workspace is %s, and writes nothing", async (actorRole) => {
    const { dependencies, log, written, audits } = world({ actorRole });

    expect(await inviteMember(dependencies, ask())).toEqual({ kind: "forbidden" });

    expect(log).toEqual(["actorRole"]);
    expect(written).toEqual([]);
    expect(audits).toEqual([]);
  });

  it.each<[WorkspaceRole]>([["admin"], ["owner"]])("lets an %s invite", async (actorRole) => {
    const { dependencies, written } = world({ actorRole });

    expect((await inviteMember(dependencies, ask({ role: "admin" }))).kind).toBe("invited");

    expect(written).toHaveLength(1);
    expect(written[0]?.role).toBe("admin");
  });

  it("refuses an address that belongs to a member, looked up in its normalised form, and writes nothing", async () => {
    const { dependencies, log, written, audits } = world({ memberHoldsEmail: true });

    expect(await inviteMember(dependencies, ask({ email: "  Ｇrace@example.test " }))).toEqual({ kind: "already_member" });

    expect(log).toEqual(["actorRole", "memberHoldsEmail Grace@example.test"]);
    expect(written).toEqual([]);
    expect(audits).toEqual([]);
  });

  it("writes the invitation with a token hash of 32 bytes that is different every time, and the configured lifetime", async () => {
    const first = world();
    const second = world();

    await inviteMember(first.dependencies, ask());
    await inviteMember(second.dependencies, ask());

    const [one] = first.written;
    const [two] = second.written;
    expect(one?.tokenHash).toHaveLength(32);
    expect(two?.tokenHash).toHaveLength(32);
    expect(one?.tokenHash.equals(two?.tokenHash ?? Buffer.alloc(0))).toBe(false);
    expect(one?.ttlSeconds).toBe(7 * 24 * 60 * 60);
    expect(one?.teamIds).toEqual([]);
  });

  it("writes the invitation with a mail ticket, which the outcome names for the job that mails it, and a different one for every write", async () => {
    const { dependencies, written } = world();

    const one = await inviteMember(dependencies, ask());
    const two = await inviteMember(dependencies, ask());

    if (one.kind !== "invited" || two.kind !== "invited") {
      throw new Error("expected both invitations to be written");
    }
    expect(written[0]?.mailTicket).toBe(one.mailTicket);
    expect(written[1]?.mailTicket).toBe(two.mailTicket);
    expect(one.mailTicket).not.toBe(written[0]?.id);
    expect(one.mailTicket).not.toBe(two.mailTicket);
  });

  it("records invitation.created with the role and neither the address nor anything else", async () => {
    const { dependencies, log, audits } = world();

    const outcome = await inviteMember(dependencies, ask({ role: "admin" }));

    expect(outcome.kind).toBe("invited");
    expect(log).toEqual(["actorRole", "memberHoldsEmail grace@example.test", "writePending", "audit", "inviteeLocale"]);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      workspaceId: WORKSPACE,
      actorType: "account",
      actorAccountId: ACTOR_ACCOUNT,
      action: "invitation.created",
      entityType: "invitation",
      metadata: { role: "admin" },
      ipPrefix: "203.0.0.0/16",
    });
    expect(JSON.stringify(audits[0])).not.toContain("grace@example.test");
  });

  it("is a resend, recorded as invitation.resent, when the address already had a pending invitation", async () => {
    const { dependencies, audits } = world({ resent: true });

    const outcome = await inviteMember(dependencies, ask());

    expect(outcome.kind).toBe("resent");
    expect(audits.map((audit) => audit.action)).toEqual(["invitation.resent"]);
  });

  it("writes the email in the invitee's language when an account holds the address, and in the inviter's otherwise", async () => {
    const known = await inviteMember(world({ inviteeLocale: "de" }).dependencies, ask({ actorLocale: "en" }));
    const unknown = await inviteMember(world({ inviteeLocale: undefined }).dependencies, ask({ actorLocale: "de" }));

    expect(known).toMatchObject({ kind: "invited", locale: "de" });
    expect(unknown).toMatchObject({ kind: "invited", locale: "de" });
    expect(await inviteMember(world({ inviteeLocale: undefined }).dependencies, ask({ actorLocale: "en" }))).toMatchObject({ locale: "en" });
  });

  it("rejects when the audit write fails, so the caller's transaction does not commit the invitation", async () => {
    const { dependencies } = world({ auditFails: true });

    await expect(inviteMember(dependencies, ask())).rejects.toThrow("the database refused");
  });
});

describe("invitationMessage", () => {
  it("names the template, the address, the language and what the email says, with the day the invitation ends", () => {
    const message = invitationMessage({
      to: "grace@example.test",
      locale: "de",
      workspaceName: "Compilers",
      inviterName: "Ada Lovelace",
      role: "admin",
      token: "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v",
      expiresAt: new Date("2026-10-26T23:59:59.000Z"),
    });

    expect(message).toEqual({
      template: "invitation",
      to: "grace@example.test",
      locale: "de",
      data: { workspaceName: "Compilers", inviterName: "Ada Lovelace", role: "admin", token: "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v", expiresOn: "2026-10-26" },
    });
  });
});
