import { describe, expect, it } from "vitest";
import {
  createAuditWriter,
  endMembership,
  type AuditRecord,
  type AuditStore,
  type MemberRoles,
  type MembershipEndAsk,
  type MembershipEndRequest,
  type MembershipEndStore,
  type WorkspaceRole,
} from "../../src/index.ts";

const WORKSPACE = "0192f3a0-cccc-7000-8000-000000000001";
const ACTOR_ACCOUNT = "0192f3a0-bbbb-7000-8000-000000000001";
const MEMBER_ACCOUNT = "0192f3a0-bbbb-7000-8000-000000000002";
const OWNER_ACCOUNT = "0192f3a0-bbbb-7000-8000-000000000003";
const ELSEWHERE_ACCOUNT = "0192f3a0-bbbb-7000-8000-000000000004";
const ACTOR = { type: "account", accountId: ACTOR_ACCOUNT, label: "Ada" } as const;

function ids(): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `0192f3a0-aaaa-7000-8000-${next.toString(16).padStart(12, "0")}`;
  };
}

interface WorldOptions {
  /** The role of each member of the workspace by account identifier; an account not listed is no member. */
  members: Readonly<Record<string, WorkspaceRole>>;
  /** The owner `longestStandingOwner` finds; undefined for none. */
  longestStandingOwner?: string;
  /** Whether the membership was there when it was deleted. */
  ends?: boolean;
  auditFails?: boolean;
  /** The workspace cannot be reached. */
  unreachable?: boolean;
}

/** The stores of one transaction: what they were asked for, in order, and the rows that stay when it ends. */
function world({ members, longestStandingOwner, ends = true, auditFails = false, unreachable = false }: WorldOptions) {
  const log: string[] = [];
  const requests: MembershipEndRequest[] = [];
  const audits: AuditRecord[] = [];
  const excluded: string[] = [];
  const store: MembershipEndStore = {
    roles(target): Promise<MemberRoles | undefined> {
      log.push(`roles ${target}`);
      return Promise.resolve(unreachable ? undefined : { actor: members[ACTOR_ACCOUNT], target: members[target] });
    },
    setRole() {
      throw new Error("a departure sets no role");
    },
    longestStandingOwner(excludingAccountId) {
      log.push("longestStandingOwner");
      excluded.push(excludingAccountId);
      return Promise.resolve(longestStandingOwner);
    },
    end(request) {
      log.push("end");
      requests.push(request);
      return Promise.resolve(ends);
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
  return { log, requests, audits, excluded, dependencies: { store, audit: createAuditWriter({ store: auditStore, newId: ids() }), newId: ids() } };
}

function ask(overrides: Partial<MembershipEndAsk> = {}): MembershipEndAsk {
  return {
    workspaceId: WORKSPACE,
    actor: ACTOR,
    actorAccountId: ACTOR_ACCOUNT,
    targetAccountId: MEMBER_ACCOUNT,
    content: "transfer",
    ipPrefix: "203.0.0.0/16",
    ...overrides,
  };
}

describe("endMembership, an admin or an owner removing a member", () => {
  it.each([
    ["an owner", "owner", "member"],
    ["an owner", "owner", "admin"],
    ["an owner", "owner", "owner"],
    ["an admin", "admin", "member"],
    ["an admin", "admin", "admin"],
  ] as const)("lets %s remove a %s %s, hands the content to the one who removes by default, and writes member.removed", async (_who, actor, target) => {
    const { dependencies, requests, audits, log } = world({ members: { [ACTOR_ACCOUNT]: actor, [MEMBER_ACCOUNT]: target } });

    const outcome = await endMembership(dependencies, ask());

    expect(outcome).toEqual({ kind: "ended", content: "transfer", transferTo: ACTOR_ACCOUNT, self: false });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      accountId: MEMBER_ACCOUNT,
      events: [{ name: "member.left", payload: { workspaceId: WORKSPACE, accountId: MEMBER_ACCOUNT, content: "transfer", transferTo: ACTOR_ACCOUNT } }],
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      workspaceId: WORKSPACE,
      actorType: "account",
      actorAccountId: ACTOR_ACCOUNT,
      actorLabel: "Ada",
      action: "member.removed",
      entityType: "member",
      entityId: MEMBER_ACCOUNT,
      metadata: { content: "transfer", transferTo: ACTOR_ACCOUNT },
      ipPrefix: "203.0.0.0/16",
    });
    expect(log).toEqual([`roles ${MEMBER_ACCOUNT}`, "end", "audit"]);
  });

  it("carries the choice to delete, and still names the recipient", async () => {
    const { dependencies, requests, audits } = world({ members: { [ACTOR_ACCOUNT]: "admin", [MEMBER_ACCOUNT]: "member" } });

    expect(await endMembership(dependencies, ask({ content: "delete" }))).toEqual({ kind: "ended", content: "delete", transferTo: ACTOR_ACCOUNT, self: false });
    expect(requests[0]?.events[0]?.payload).toMatchObject({ content: "delete", transferTo: ACTOR_ACCOUNT });
    expect(audits[0]?.metadata).toEqual({ content: "delete", transferTo: ACTOR_ACCOUNT });
  });

  it("hands the content to the member named, who must be another current member, and checks that under the same lock", async () => {
    const { dependencies, requests, log } = world({ members: { [ACTOR_ACCOUNT]: "admin", [MEMBER_ACCOUNT]: "member", [OWNER_ACCOUNT]: "owner" } });

    const outcome = await endMembership(dependencies, ask({ transferTo: OWNER_ACCOUNT.toUpperCase() }));

    expect(outcome).toEqual({ kind: "ended", content: "transfer", transferTo: OWNER_ACCOUNT, self: false });
    expect(requests[0]?.events[0]?.payload.transferTo).toBe(OWNER_ACCOUNT);
    expect(log).toEqual([`roles ${MEMBER_ACCOUNT}`, `roles ${OWNER_ACCOUNT}`, "end", "audit"]);
  });

  it.each([
    ["the member who is removed", MEMBER_ACCOUNT, "invalid_recipient"],
    ["an account that is no member of the workspace", ELSEWHERE_ACCOUNT, "recipient_not_found"],
  ] as const)("refuses and writes nothing when the recipient is %s", async (_name, transferTo, kind) => {
    const { dependencies, requests, audits } = world({ members: { [ACTOR_ACCOUNT]: "admin", [MEMBER_ACCOUNT]: "member" } });

    expect(await endMembership(dependencies, ask({ transferTo }))).toEqual({ kind });
    expect(requests).toEqual([]);
    expect(audits).toEqual([]);
  });

  it.each([
    ["an admin removes an owner", { [ACTOR_ACCOUNT]: "admin", [MEMBER_ACCOUNT]: "owner" }],
    ["a member removes a member", { [ACTOR_ACCOUNT]: "member", [MEMBER_ACCOUNT]: "member" }],
    ["a member removes an owner", { [ACTOR_ACCOUNT]: "member", [MEMBER_ACCOUNT]: "owner" }],
    ["a member removes an admin", { [ACTOR_ACCOUNT]: "member", [MEMBER_ACCOUNT]: "admin" }],
  ] as const)("refuses and writes nothing when %s", async (_name, members) => {
    const { dependencies, requests, audits, log } = world({ members });

    expect(await endMembership(dependencies, ask())).toEqual({ kind: "forbidden" });
    expect(requests).toEqual([]);
    expect(audits).toEqual([]);
    expect(log).toEqual([`roles ${MEMBER_ACCOUNT}`]);
  });

  it("judges the permission before the recipient, so a forbidden removal does not tell whether the recipient is a member", async () => {
    const { dependencies, log } = world({ members: { [ACTOR_ACCOUNT]: "admin", [MEMBER_ACCOUNT]: "owner" } });

    expect(await endMembership(dependencies, ask({ transferTo: ELSEWHERE_ACCOUNT }))).toEqual({ kind: "forbidden" });
    expect(log).toEqual([`roles ${MEMBER_ACCOUNT}`]);
  });

  it("answers not found for a target outside the workspace, for an account that asks and is no member, and for a workspace that cannot be reached", async () => {
    const cases: WorldOptions[] = [
      { members: { [ACTOR_ACCOUNT]: "owner" } },
      { members: { [MEMBER_ACCOUNT]: "member" } },
      { members: { [ACTOR_ACCOUNT]: "owner", [MEMBER_ACCOUNT]: "member" }, unreachable: true },
    ];
    for (const options of cases) {
      const { dependencies, requests, audits } = world(options);

      expect(await endMembership(dependencies, ask())).toEqual({ kind: "not_found" });
      expect(requests).toEqual([]);
      expect(audits).toEqual([]);
    }
  });

  it("answers not found and writes no audit event when the member disappeared before the delete", async () => {
    const { dependencies, audits } = world({ members: { [ACTOR_ACCOUNT]: "owner", [MEMBER_ACCOUNT]: "member" }, ends: false });

    expect(await endMembership(dependencies, ask())).toEqual({ kind: "not_found" });
    expect(audits).toEqual([]);
  });

  it("rejects when the audit event cannot be written, so the caller's transaction does not commit", async () => {
    const { dependencies } = world({ members: { [ACTOR_ACCOUNT]: "owner", [MEMBER_ACCOUNT]: "member" }, auditFails: true });

    await expect(endMembership(dependencies, ask())).rejects.toThrow("the database refused");
  });
});

describe("endMembership, a member leaving", () => {
  it.each(["owner", "admin", "member"] as const)("lets a %s leave, hands the content to the longest-standing owner by default, and writes member.left", async (role) => {
    const { dependencies, requests, audits, excluded, log } = world({ members: { [ACTOR_ACCOUNT]: role, [OWNER_ACCOUNT]: "owner" }, longestStandingOwner: OWNER_ACCOUNT });

    const outcome = await endMembership(dependencies, ask({ targetAccountId: ACTOR_ACCOUNT, content: "delete" }));

    expect(outcome).toEqual({ kind: "ended", content: "delete", transferTo: OWNER_ACCOUNT, self: true });
    expect(excluded).toEqual([ACTOR_ACCOUNT]);
    expect(requests[0]).toMatchObject({
      accountId: ACTOR_ACCOUNT,
      events: [{ name: "member.left", payload: { workspaceId: WORKSPACE, accountId: ACTOR_ACCOUNT, content: "delete", transferTo: OWNER_ACCOUNT } }],
    });
    expect(audits[0]).toMatchObject({ action: "member.left", entityType: "member", entityId: ACTOR_ACCOUNT, metadata: { content: "delete", transferTo: OWNER_ACCOUNT } });
    expect(log).toEqual([`roles ${ACTOR_ACCOUNT}`, "longestStandingOwner", "end", "audit"]);
  });

  it("recognises the member who names themselves whatever the case of the identifier", async () => {
    const { dependencies } = world({ members: { [ACTOR_ACCOUNT]: "member", [OWNER_ACCOUNT]: "owner" }, longestStandingOwner: OWNER_ACCOUNT });

    expect(await endMembership(dependencies, ask({ targetAccountId: ACTOR_ACCOUNT.toUpperCase() }))).toMatchObject({ kind: "ended", self: true });
  });

  it("hands the content to the member named when one is given", async () => {
    const { dependencies, requests, log } = world({ members: { [ACTOR_ACCOUNT]: "member", [MEMBER_ACCOUNT]: "admin" }, longestStandingOwner: OWNER_ACCOUNT });

    const outcome = await endMembership(dependencies, ask({ targetAccountId: ACTOR_ACCOUNT, transferTo: MEMBER_ACCOUNT }));

    expect(outcome).toEqual({ kind: "ended", content: "transfer", transferTo: MEMBER_ACCOUNT, self: true });
    expect(requests[0]?.events[0]?.payload.transferTo).toBe(MEMBER_ACCOUNT);
    expect(log).not.toContain("longestStandingOwner");
  });

  it("refuses a recipient who is the member that leaves", async () => {
    const { dependencies, requests } = world({ members: { [ACTOR_ACCOUNT]: "member" }, longestStandingOwner: OWNER_ACCOUNT });

    expect(await endMembership(dependencies, ask({ targetAccountId: ACTOR_ACCOUNT, transferTo: ACTOR_ACCOUNT }))).toEqual({ kind: "invalid_recipient" });
    expect(requests).toEqual([]);
  });

  it("refuses and writes nothing when the owner who leaves is the one the workspace has", async () => {
    const { dependencies, requests, audits } = world({ members: { [ACTOR_ACCOUNT]: "owner", [MEMBER_ACCOUNT]: "admin" } });

    expect(await endMembership(dependencies, ask({ targetAccountId: ACTOR_ACCOUNT }))).toEqual({ kind: "last_owner" });
    expect(requests).toEqual([]);
    expect(audits).toEqual([]);
  });

  it("leaves the refusal of a last owner who names a recipient to the database, which refuses the commit", async () => {
    const { dependencies, requests } = world({ members: { [ACTOR_ACCOUNT]: "owner", [MEMBER_ACCOUNT]: "admin" } });

    expect(await endMembership(dependencies, ask({ targetAccountId: ACTOR_ACCOUNT, transferTo: MEMBER_ACCOUNT }))).toMatchObject({ kind: "ended", self: true });
    expect(requests).toHaveLength(1);
  });
});
