import { describe, expect, it } from "vitest";
import {
  changeMemberRole,
  createAuditWriter,
  endMembership,
  requestWorkspaceDeletion,
  transferOwnership,
  type AuditRecord,
  type AuditStore,
  type DomainEvent,
  type MembershipEndStore,
  type WorkspaceRole,
} from "../../src/index.ts";

// The roles table of doc 02 section 3.3 run against the services that judge a caller's role: changing a role,
// removing a member or leaving, transferring ownership and requesting the deletion of a workspace (doc 10 T2).
// The stores are one roster of members by account, so what a call asks of the roles it reads and what it leaves
// behind in them are both visible. The renaming of a workspace and the change of its settings judge nothing in
// the service: the authorization stage of the server refuses a member before they run, and the integration
// suite of the server asserts that. The failure scenarios: a role that may do what the table does not give it,
// a refusal that has written something before it refused, and a member whose membership ended and who is
// still answered as one by the next call of any of the services.

const WORKSPACE = "0192f3a0-cccc-7000-8000-000000000001";
const CALLER = "0192f3a0-bbbb-7000-8000-000000000001";
const TARGET = "0192f3a0-bbbb-7000-8000-000000000002";
const OWNER = "0192f3a0-bbbb-7000-8000-000000000003";
const REMOVER = "0192f3a0-bbbb-7000-8000-000000000004";

const ROLES = ["owner", "admin", "member"] as const satisfies readonly WorkspaceRole[];

function ids(): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `0192f3a0-aaaa-7000-8000-${next.toString(16).padStart(12, "0")}`;
  };
}

// Doc 02 section 3.3. "Change a member's role between admin and member; remove members": an owner, and an admin
// who does not touch an owner. "Promote to owner, transfer ownership, demote an owner", and "Delete the
// workspace": an owner.
const mayManage = (actor: WorkspaceRole, target: WorkspaceRole): boolean => actor === "owner" || (actor === "admin" && target !== "owner");
const mayChangeRole = (actor: WorkspaceRole, target: WorkspaceRole, to: WorkspaceRole): boolean => mayManage(actor, target) && (to !== "owner" || actor === "owner");

type Roster = Map<string, WorkspaceRole>;

/**
 * The workspace the transactions of a test act on: the caller and the member the call is about in the roles
 * given, and another owner, so the workspace has an owner whoever the call removes or demotes. `bind` gives the
 * stores of a transaction that acts for one account; they all read and write the one roster.
 */
function world(callerRole: WorkspaceRole | undefined, targetRole: WorkspaceRole | undefined) {
  const roster: Roster = new Map<string, WorkspaceRole>([[OWNER, "owner"]]);
  if (callerRole !== undefined) {
    roster.set(CALLER, callerRole);
  }
  if (targetRole !== undefined) {
    roster.set(TARGET, targetRole);
  }
  const queued: DomainEvent<"member.left">[] = [];
  const audits: AuditRecord[] = [];
  const auditStore: AuditStore = {
    insert(record) {
      audits.push(record);
      return Promise.resolve();
    },
  };
  const audit = createAuditWriter({ store: auditStore, newId: ids() });
  const bind = (accountOfTransaction: string) => {
    const store: MembershipEndStore = {
      roles: (target) => Promise.resolve({ actor: roster.get(accountOfTransaction), target: roster.get(target.toLowerCase()) }),
      setRole(target, role) {
        if (!roster.has(target.toLowerCase())) {
          return Promise.resolve(false);
        }
        roster.set(target.toLowerCase(), role);
        return Promise.resolve(true);
      },
      longestStandingOwner: (excluding) => Promise.resolve([...roster].find(([account, role]) => role === "owner" && account !== excluding)?.[0]),
      end(request) {
        queued.push(...request.events);
        return Promise.resolve(roster.delete(request.accountId));
      },
    };
    return {
      dependencies: { store, audit },
      ending: { store, audit, newId: ids() },
      actor: { type: "account", accountId: accountOfTransaction, label: "Ada" } as const,
    };
  };
  return { roster, queued, audits, bind };
}

const actions = (audits: readonly AuditRecord[]): string[] => audits.map((record) => record.action);

describe("changeMemberRole by the roles table", () => {
  const rows = ROLES.flatMap((actor) => ROLES.flatMap((target) => ROLES.map((to) => [actor, target, to] as const)));

  it.each(rows)("as %s, a %s becomes %s", async (actor, target, to) => {
    const { roster, audits, bind } = world(actor, target);
    const { dependencies, actor: asCaller } = bind(CALLER);

    const outcome = await changeMemberRole(dependencies, { workspaceId: WORKSPACE, actor: asCaller, actorAccountId: CALLER, targetAccountId: TARGET, role: to, ipPrefix: null });

    if (!mayChangeRole(actor, target, to)) {
      expect(outcome).toEqual({ kind: "forbidden" });
      expect(roster.get(TARGET)).toBe(target);
      expect(audits).toEqual([]);
    } else if (target === to) {
      expect(outcome).toEqual({ kind: "unchanged", role: target });
      expect(roster.get(TARGET)).toBe(target);
      expect(audits).toEqual([]);
    } else {
      expect(outcome).toEqual({ kind: "changed", from: target, to, self: false });
      expect(roster.get(TARGET)).toBe(to);
      expect(actions(audits)).toEqual(["member.role_changed"]);
    }
  });
});

describe("endMembership by the roles table", () => {
  const removals = ROLES.flatMap((actor) => ROLES.map((target) => [actor, target] as const));

  it.each(removals)("as %s, removing a %s", async (actor, target) => {
    const { roster, queued, audits, bind } = world(actor, target);
    const { ending, actor: asCaller } = bind(CALLER);

    const outcome = await endMembership(ending, {
      workspaceId: WORKSPACE,
      actor: asCaller,
      actorAccountId: CALLER,
      targetAccountId: TARGET,
      content: "transfer",
      ipPrefix: null,
    });

    if (mayManage(actor, target)) {
      expect(outcome).toEqual({ kind: "ended", content: "transfer", transferTo: CALLER, self: false });
      expect(roster.has(TARGET)).toBe(false);
      expect(queued).toMatchObject([{ name: "member.left", payload: { workspaceId: WORKSPACE, accountId: TARGET, content: "transfer", transferTo: CALLER } }]);
      expect(actions(audits)).toEqual(["member.removed"]);
    } else {
      expect(outcome).toEqual({ kind: "forbidden" });
      expect(roster.get(TARGET)).toBe(target);
      expect(queued).toEqual([]);
      expect(audits).toEqual([]);
    }
  });

  it.each(ROLES)("a %s leaves, and the content goes to the longest-standing owner", async (role) => {
    const { roster, queued, audits, bind } = world(role, undefined);
    const { ending, actor: asCaller } = bind(CALLER);

    const outcome = await endMembership(ending, {
      workspaceId: WORKSPACE,
      actor: asCaller,
      actorAccountId: CALLER,
      targetAccountId: CALLER,
      content: "transfer",
      ipPrefix: null,
    });

    expect(outcome).toEqual({ kind: "ended", content: "transfer", transferTo: OWNER, self: true });
    expect(roster.has(CALLER)).toBe(false);
    expect(queued).toHaveLength(1);
    expect(actions(audits)).toEqual(["member.left"]);
  });

  it("refuses the only owner who leaves, whatever the content choice, and writes and queues nothing", async () => {
    for (const content of ["transfer", "delete"] as const) {
      const { roster, queued, audits, bind } = world(undefined, undefined);
      const { ending, actor: asOwner } = bind(OWNER);

      const outcome = await endMembership(ending, {
        workspaceId: WORKSPACE,
        actor: asOwner,
        actorAccountId: OWNER,
        targetAccountId: OWNER,
        content,
        ipPrefix: null,
      });

      expect(outcome).toEqual({ kind: "last_owner" });
      expect(roster.get(OWNER)).toBe("owner");
      expect(queued).toEqual([]);
      expect(audits).toEqual([]);
    }
  });
});

describe("transferOwnership by the roles table", () => {
  const rows = ROLES.flatMap((actor) => ROLES.flatMap((target) => [false, true].map((demoteSelf) => [actor, target, demoteSelf] as const)));

  it.each(rows)("as %s, to a %s, with demoteSelf %s", async (actor, target, demoteSelf) => {
    const { roster, audits, bind } = world(actor, target);
    const { dependencies, actor: asCaller } = bind(CALLER);

    const outcome = await transferOwnership(dependencies, {
      workspaceId: WORKSPACE,
      actor: asCaller,
      actorAccountId: CALLER,
      targetAccountId: TARGET,
      demoteSelf,
      ipPrefix: null,
    });

    if (actor !== "owner") {
      expect(outcome).toEqual({ kind: "forbidden" });
      expect(roster.get(CALLER)).toBe(actor);
      expect(roster.get(TARGET)).toBe(target);
      expect(audits).toEqual([]);
    } else if (target === "owner" && !demoteSelf) {
      expect(outcome).toEqual({ kind: "unchanged" });
      expect(audits).toEqual([]);
    } else {
      expect(outcome).toEqual({ kind: "transferred", promoted: target !== "owner", demoted: demoteSelf });
      expect(roster.get(TARGET)).toBe("owner");
      expect(roster.get(CALLER)).toBe(demoteSelf ? "admin" : "owner");
      expect(actions(audits)).toEqual(["workspace.ownership_transferred"]);
    }
  });
});

describe("requestWorkspaceDeletion by the roles table", () => {
  it.each(ROLES)("as %s", async (role) => {
    const audits: AuditRecord[] = [];
    const marked: string[] = [];
    const store = {
      // The store's contract: it marks the workspace only for an owner of it.
      markDeleting: () => {
        marked.push(role);
        return Promise.resolve(role === "owner");
      },
    };
    const audit = createAuditWriter({ store: { insert: (record) => (audits.push(record), Promise.resolve()) }, newId: ids() });

    const outcome = await requestWorkspaceDeletion(
      { store, audit, guard: () => Promise.resolve({ outcome: "allow" }) },
      { workspaceId: WORKSPACE, actor: { type: "account", accountId: CALLER, label: "Ada" }, ipPrefix: null },
    );

    expect(outcome).toEqual(role === "owner" ? { kind: "requested" } : { kind: "unavailable" });
    expect(actions(audits)).toEqual(role === "owner" ? ["workspace.deletion_requested"] : []);
  });
});

describe("a member whose membership has ended", () => {
  const departures = ROLES.flatMap((role) => (["removed", "left"] as const).map((how) => [role, how] as const));

  it.each(departures)("a %s who is %s is no member to any service on the very next call", async (role, how) => {
    const { roster, queued, audits, bind } = world(role, undefined);
    roster.set(REMOVER, "owner");
    const departing = bind(how === "left" ? CALLER : REMOVER);
    const ended = await endMembership(departing.ending, {
      workspaceId: WORKSPACE,
      actor: departing.actor,
      actorAccountId: departing.actor.accountId,
      targetAccountId: CALLER,
      content: "transfer",
      ipPrefix: null,
    });
    expect(ended).toMatchObject({ kind: "ended" });
    expect(roster.has(CALLER)).toBe(false);
    const rosterAfter = new Map(roster);
    const auditsAfter = audits.length;
    const next = bind(CALLER);
    const as = { workspaceId: WORKSPACE, actor: next.actor, actorAccountId: CALLER, ipPrefix: null };

    const outcomes = [
      await changeMemberRole(next.dependencies, { ...as, targetAccountId: OWNER, role: "member" }),
      await changeMemberRole(next.dependencies, { ...as, targetAccountId: CALLER, role: "owner" }),
      await endMembership(next.ending, { ...as, targetAccountId: OWNER, content: "delete" }),
      await endMembership(next.ending, { ...as, targetAccountId: CALLER, content: "delete" }),
      await transferOwnership(next.dependencies, { ...as, targetAccountId: OWNER, demoteSelf: true }),
    ];

    expect(outcomes).toEqual(outcomes.map(() => ({ kind: "not_found" })));
    expect(roster).toEqual(rosterAfter);
    expect(audits).toHaveLength(auditsAfter);
    expect(queued).toHaveLength(1);
  });
});
