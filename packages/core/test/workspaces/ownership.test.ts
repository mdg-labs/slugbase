import { describe, expect, it } from "vitest";
import {
  createAuditWriter,
  transferOwnership,
  type AuditRecord,
  type AuditStore,
  type MemberRoleStore,
  type MemberRoles,
  type OwnershipTransferAsk,
  type WorkspaceRole,
} from "../../src/index.ts";

const WORKSPACE = "0192f3a0-cccc-7000-8000-000000000001";
const OWNER = "0192f3a0-bbbb-7000-8000-000000000001";
const RECIPIENT = "0192f3a0-bbbb-7000-8000-000000000002";
const ACTOR = { type: "account", accountId: OWNER, label: "Ada" } as const;

function ids(): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `0192f3a0-aaaa-7000-8000-${next.toString(16).padStart(12, "0")}`;
  };
}

interface WorldOptions {
  roles: MemberRoles | undefined;
  /** The accounts whose row `setRole` does not find. */
  missing?: readonly string[];
  auditFails?: boolean;
}

/** The stores of one transaction: what they were asked for, in order, and the audit rows that stay when it ends. */
function world({ roles, missing = [], auditFails = false }: WorldOptions) {
  const log: string[] = [];
  const written: { account: string; role: WorkspaceRole }[] = [];
  const audits: AuditRecord[] = [];
  const store: MemberRoleStore = {
    roles(target) {
      log.push(`roles ${target}`);
      return Promise.resolve(roles);
    },
    setRole(target, role) {
      log.push("setRole");
      if (missing.includes(target)) {
        return Promise.resolve(false);
      }
      written.push({ account: target, role });
      return Promise.resolve(true);
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
  return { log, written, audits, dependencies: { store, audit: createAuditWriter({ store: auditStore, newId: ids() }) } };
}

function ask(demoteSelf: boolean, overrides: Partial<OwnershipTransferAsk> = {}): OwnershipTransferAsk {
  return { workspaceId: WORKSPACE, actor: ACTOR, actorAccountId: OWNER, targetAccountId: RECIPIENT, demoteSelf, ipPrefix: "203.0.0.0/16", ...overrides };
}

describe("transferOwnership", () => {
  it.each(["admin", "member"] as const)("makes a %s an owner, keeps the caller an owner and writes workspace.ownership_transferred", async (target) => {
    const { dependencies, written, audits, log } = world({ roles: { actor: "owner", target } });

    const outcome = await transferOwnership(dependencies, ask(false));

    expect(outcome).toEqual({ kind: "transferred", promoted: true, demoted: false });
    expect(written).toEqual([{ account: RECIPIENT, role: "owner" }]);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      workspaceId: WORKSPACE,
      actorType: "account",
      actorAccountId: OWNER,
      actorLabel: "Ada",
      action: "workspace.ownership_transferred",
      entityType: "member",
      entityId: RECIPIENT,
      metadata: { demoteSelf: "false" },
      ipPrefix: "203.0.0.0/16",
    });
    expect(log).toEqual([`roles ${RECIPIENT}`, "setRole", "audit"]);
  });

  it("promotes the recipient before it demotes the caller, in the one transaction the stores are bound to", async () => {
    const { dependencies, written, audits, log } = world({ roles: { actor: "owner", target: "member" } });

    const outcome = await transferOwnership(dependencies, ask(true));

    expect(outcome).toEqual({ kind: "transferred", promoted: true, demoted: true });
    expect(written).toEqual([
      { account: RECIPIENT, role: "owner" },
      { account: OWNER, role: "admin" },
    ]);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ metadata: { demoteSelf: "true" } });
    expect(log).toEqual([`roles ${RECIPIENT}`, "setRole", "setRole", "audit"]);
  });

  it("only demotes the caller when the recipient is already an owner, and says nobody was promoted", async () => {
    const { dependencies, written, audits } = world({ roles: { actor: "owner", target: "owner" } });

    expect(await transferOwnership(dependencies, ask(true))).toEqual({ kind: "transferred", promoted: false, demoted: true });
    expect(written).toEqual([{ account: OWNER, role: "admin" }]);
    expect(audits).toHaveLength(1);
  });

  it("writes nothing when the recipient is already an owner and the caller stays one", async () => {
    const { dependencies, written, audits } = world({ roles: { actor: "owner", target: "owner" } });

    expect(await transferOwnership(dependencies, ask(false))).toEqual({ kind: "unchanged" });
    expect(written).toEqual([]);
    expect(audits).toEqual([]);
  });

  it.each([
    ["an admin", "admin"],
    ["a member", "member"],
  ] as const)("refuses %s and writes nothing: only an owner transfers ownership", async (_who, actor) => {
    const { dependencies, written, audits, log } = world({ roles: { actor, target: "member" } });

    expect(await transferOwnership(dependencies, ask(false))).toEqual({ kind: "forbidden" });
    expect(written).toEqual([]);
    expect(audits).toEqual([]);
    expect(log).toEqual([`roles ${RECIPIENT}`]);
  });

  it("answers not found for a recipient outside the workspace, and for a workspace that cannot be reached", async () => {
    for (const roles of [{ actor: "owner", target: undefined }, undefined] as const) {
      const { dependencies, written, audits } = world({ roles });

      expect(await transferOwnership(dependencies, ask(true))).toEqual({ kind: "not_found" });
      expect(written).toEqual([]);
      expect(audits).toEqual([]);
    }
  });

  it("answers not found when the caller is no member of the workspace", async () => {
    const { dependencies, written } = world({ roles: { actor: undefined, target: "member" } });

    expect(await transferOwnership(dependencies, ask(false))).toEqual({ kind: "not_found" });
    expect(written).toEqual([]);
  });

  it("refuses a recipient that is the caller, in whatever case the identifier is written, and writes nothing", async () => {
    const { dependencies, written, audits } = world({ roles: { actor: "owner", target: "owner" } });

    expect(await transferOwnership(dependencies, ask(true, { targetAccountId: OWNER.toUpperCase() }))).toEqual({ kind: "invalid_recipient" });
    expect(written).toEqual([]);
    expect(audits).toEqual([]);
  });

  it("rejects, so the transaction does not commit, when the recipient disappeared before the write", async () => {
    const { dependencies, audits } = world({ roles: { actor: "owner", target: "member" }, missing: [RECIPIENT] });

    await expect(transferOwnership(dependencies, ask(true))).rejects.toThrow("recipient");
    expect(audits).toEqual([]);
  });

  it("rejects, so the promotion is not committed alone, when the caller's own row cannot be written", async () => {
    const { dependencies, audits } = world({ roles: { actor: "owner", target: "member" }, missing: [OWNER] });

    await expect(transferOwnership(dependencies, ask(true))).rejects.toThrow("caller");
    expect(audits).toEqual([]);
  });

  it("rejects when the audit event cannot be written, so the caller's transaction does not commit", async () => {
    const { dependencies } = world({ roles: { actor: "owner", target: "member" }, auditFails: true });

    await expect(transferOwnership(dependencies, ask(true))).rejects.toThrow("the database refused");
  });
});
