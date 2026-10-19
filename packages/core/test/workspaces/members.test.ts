import { describe, expect, it } from "vitest";
import {
  changeMemberRole,
  createAuditWriter,
  type AuditRecord,
  type AuditStore,
  type MemberRoleAsk,
  type MemberRoleStore,
  type MemberRoles,
  type WorkspaceRole,
} from "../../src/index.ts";

const WORKSPACE = "0192f3a0-cccc-7000-8000-000000000001";
const ACTOR_ACCOUNT = "0192f3a0-bbbb-7000-8000-000000000001";
const OTHER_ACCOUNT = "0192f3a0-bbbb-7000-8000-000000000002";
const ACTOR = { type: "account", accountId: ACTOR_ACCOUNT, label: "Ada" } as const;

function ids(): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `0192f3a0-aaaa-7000-8000-${next.toString(16).padStart(12, "0")}`;
  };
}

interface WorldOptions {
  roles: MemberRoles | undefined;
  setRole?: boolean;
  auditFails?: boolean;
}

/** The stores of one transaction: what they were asked for, in order, and the audit rows that stay when it ends. */
function world({ roles, setRole = true, auditFails = false }: WorldOptions) {
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
      written.push({ account: target, role });
      return Promise.resolve(setRole);
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

function ask(role: WorkspaceRole, overrides: Partial<MemberRoleAsk> = {}): MemberRoleAsk {
  return { workspaceId: WORKSPACE, actor: ACTOR, actorAccountId: ACTOR_ACCOUNT, targetAccountId: OTHER_ACCOUNT, role, ipPrefix: "203.0.0.0/16", ...overrides };
}

describe("changeMemberRole", () => {
  it.each([
    // who asks, its role, the target's role, the role asked for
    ["an owner", "owner", "member", "admin"],
    ["an owner", "owner", "admin", "member"],
    ["an owner", "owner", "member", "owner"],
    ["an owner", "owner", "owner", "admin"],
    ["an owner", "owner", "owner", "member"],
    ["an admin", "admin", "member", "admin"],
    ["an admin", "admin", "admin", "member"],
  ] as const)("lets %s change a %s into a %s, and writes member.role_changed with the old and the new role", async (_who, actor, target, to) => {
    const { dependencies, written, audits, log } = world({ roles: { actor, target } });

    const outcome = await changeMemberRole(dependencies, ask(to));

    expect(outcome).toEqual({ kind: "changed", from: target, to, self: false });
    expect(written).toEqual([{ account: OTHER_ACCOUNT, role: to }]);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      workspaceId: WORKSPACE,
      actorType: "account",
      actorAccountId: ACTOR_ACCOUNT,
      actorLabel: "Ada",
      action: "member.role_changed",
      entityType: "member",
      entityId: OTHER_ACCOUNT,
      metadata: { from: target, to },
      ipPrefix: "203.0.0.0/16",
    });
    expect(log).toEqual([`roles ${OTHER_ACCOUNT}`, "setRole", "audit"]);
  });

  it("says the change is the caller's own when the member is the account that asks", async () => {
    const { dependencies } = world({ roles: { actor: "owner", target: "owner" } });

    expect(await changeMemberRole(dependencies, ask("admin", { targetAccountId: ACTOR_ACCOUNT.toUpperCase() }))).toEqual({
      kind: "changed",
      from: "owner",
      to: "admin",
      self: true,
    });
  });

  it("lets an admin step down to member", async () => {
    const { dependencies, audits } = world({ roles: { actor: "admin", target: "admin" } });

    expect(await changeMemberRole(dependencies, ask("member", { targetAccountId: ACTOR_ACCOUNT }))).toEqual({ kind: "changed", from: "admin", to: "member", self: true });
    expect(audits).toHaveLength(1);
  });

  it.each([
    ["an admin promotes a member to owner", { actor: "admin", target: "member" }, "owner"],
    ["an admin promotes an admin to owner", { actor: "admin", target: "admin" }, "owner"],
    ["an admin promotes itself to owner", { actor: "admin", target: "admin" }, "owner"],
    ["an admin demotes an owner to admin", { actor: "admin", target: "owner" }, "admin"],
    ["an admin demotes an owner to member", { actor: "admin", target: "owner" }, "member"],
    ["an admin asks for the role an owner already has", { actor: "admin", target: "owner" }, "owner"],
    ["a member changes a member", { actor: "member", target: "member" }, "admin"],
    ["a member promotes itself", { actor: "member", target: "member" }, "owner"],
  ] as const)("refuses and writes nothing when %s", async (_name, roles, to) => {
    const { dependencies, written, audits, log } = world({ roles });

    expect(await changeMemberRole(dependencies, ask(to))).toEqual({ kind: "forbidden" });
    expect(written).toEqual([]);
    expect(audits).toEqual([]);
    expect(log).toEqual([`roles ${OTHER_ACCOUNT}`]);
  });

  it("writes nothing when the member already has the role, an owner asked to become an owner included", async () => {
    for (const [roles, to] of [
      [{ actor: "owner", target: "owner" }, "owner"],
      [{ actor: "admin", target: "member" }, "member"],
      [{ actor: "owner", target: "admin" }, "admin"],
    ] as const) {
      const { dependencies, written, audits } = world({ roles });

      expect(await changeMemberRole(dependencies, ask(to))).toEqual({ kind: "unchanged", role: roles.target });
      expect(written).toEqual([]);
      expect(audits).toEqual([]);
    }
  });

  it("answers not found for a target outside the workspace, whoever asks, and for a workspace that cannot be reached", async () => {
    for (const roles of [{ actor: "owner", target: undefined }, { actor: "admin", target: undefined }, undefined] as const) {
      const { dependencies, written, audits } = world({ roles });

      expect(await changeMemberRole(dependencies, ask("admin"))).toEqual({ kind: "not_found" });
      expect(written).toEqual([]);
      expect(audits).toEqual([]);
    }
  });

  it("answers not found when the account that asks is no member of the workspace", async () => {
    const { dependencies, written } = world({ roles: { actor: undefined, target: "member" } });

    expect(await changeMemberRole(dependencies, ask("admin"))).toEqual({ kind: "not_found" });
    expect(written).toEqual([]);
  });

  it("answers not found and writes no event when the member disappeared before the write", async () => {
    const { dependencies, audits } = world({ roles: { actor: "owner", target: "member" }, setRole: false });

    expect(await changeMemberRole(dependencies, ask("admin"))).toEqual({ kind: "not_found" });
    expect(audits).toEqual([]);
  });

  it("rejects when the audit event cannot be written, so the caller's transaction does not commit", async () => {
    const { dependencies } = world({ roles: { actor: "owner", target: "member" }, auditFails: true });

    await expect(changeMemberRole(dependencies, ask("admin"))).rejects.toThrow("the database refused");
  });
});
