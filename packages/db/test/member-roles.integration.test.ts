import { changeMemberRole, createAuditWriter } from "@slugbase/core";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditEventRepository, createAuthStore, isLastOwnerViolation, memberRepository, type AuthStore } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, freshToken, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace, workspaceChecksum, type Role } from "./support/workspace-fixture.ts";

// The members of a workspace, their roles and the rule that a workspace always has an owner (doc 02 section
// 3.3, doc 05 sections 2.1 and 2.2, doc 04 section 10.5, doc 10 T1 and T2). The failure scenarios: two owners
// demoting each other at the same moment (each transaction sees the other still an owner, so without the
// lock of the workspace's row both would commit and leave none), the last owner demoted or removed, a
// member's account read or changed by an account that shares no workspace with it, and a workspace B read or
// changed from a transaction acting in A. The RLS-only checks run statements as slugbase_app with the tenant
// settings of A and no application layer at all.

const HOOK_TIMEOUT_MS = 300_000;
const CHECK_VIOLATION = "23514";
const INSUFFICIENT_PRIVILEGE = "42501";

let db: TestDatabase;
let store: AuthStore;

function appUrl(database: TestDatabase): string {
  const { options } = database.app;
  const url = new URL("postgres://localhost");
  url.hostname = String(options.host[0]);
  url.port = String(options.port[0]);
  url.username = options.user;
  url.password = String(options.pass);
  url.pathname = `/${options.database}`;
  return url.href;
}

beforeAll(async () => {
  db = await createTestDatabase();
  store = createAuthStore({ url: appUrl(db), poolSize: 4 });
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await store.close();
  await db.drop();
}, HOOK_TIMEOUT_MS);

let emailNumber = 0;
async function account(displayName?: string): Promise<string> {
  emailNumber += 1;
  const id = freshId();
  await seedAccount(db, { id, email: `member${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub" });
  if (displayName !== undefined) {
    await asSystem(db, (tx) => tx`UPDATE accounts SET display_name = ${displayName} WHERE id = ${id}`);
  }
  return id;
}

interface Workspace {
  readonly workspaceId: string;
  readonly members: readonly { readonly accountId: string; readonly role: Role }[];
}

/** A workspace with one member of each role given, in that order. */
async function workspaceOf(...roles: Role[]): Promise<Workspace> {
  const workspaceId = await seedWorkspace(db, { name: "Members test" });
  const members: { accountId: string; role: Role }[] = [];
  for (const role of roles) {
    const accountId = await account();
    await seedMember(db, { workspaceId, accountId, role });
    members.push({ accountId, role });
  }
  return { workspaceId, members };
}

function inTenant<T>(tenant: { accountId: string; workspaceId?: string }, work: Parameters<typeof db.tenant.withTenant<T>>[1]): Promise<T> {
  return db.tenant.withTenant({ ...tenant, requestId: "member-roles-test" }, work);
}

/** Runs `work` as slugbase_app with the settings of withTenant and nothing else: no repository, no application layer. */
async function appAs<T>(settings: { accountId: string; workspaceId?: string }, work: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  const result = await db.app.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${settings.accountId}, true), set_config('app.workspace_id', ${settings.workspaceId ?? ""}, true)`;
    return { value: await work(tx) };
  });
  return result.value;
}

async function refusedWith(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
  } catch (error) {
    let current: unknown = error;
    for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth += 1) {
      const { code, cause } = current as { code?: unknown; cause?: unknown };
      if (typeof code === "string") {
        return code;
      }
      current = cause;
    }
    throw error;
  }
  return undefined;
}

async function rolesOf(workspaceId: string): Promise<Record<string, string>> {
  const rows = await asSystem(db, (tx) => tx<{ account_id: string; role: string }[]>`SELECT account_id, role::text AS role FROM workspace_members WHERE workspace_id = ${workspaceId}`);
  return Object.fromEntries(rows.map((row) => [row.account_id, row.role]));
}

async function ownersOf(workspaceId: string): Promise<number> {
  return Object.values(await rolesOf(workspaceId)).filter((role) => role === "owner").length;
}

function setRole(sqlTx: postgres.TransactionSql, workspaceId: string, accountId: string, role: Role): Promise<postgres.RowList<postgres.Row[]>> {
  return sqlTx`UPDATE workspace_members SET role = ${role}::member_role WHERE workspace_id = ${workspaceId} AND account_id = ${accountId}`;
}

describe("the privileges and policies behind the members", () => {
  it("lets the application role write the role and last_active_at of a membership and no other column", async () => {
    const rows = await db.owner<{ column: string }[]>`
      SELECT a.attname AS column
      FROM pg_attribute a
      WHERE a.attrelid = 'public.workspace_members'::regclass AND a.attnum > 0 AND NOT a.attisdropped
        AND has_column_privilege('slugbase_app', 'public.workspace_members', a.attname, 'UPDATE')
      ORDER BY a.attname`;
    expect(rows.map((row) => row.column)).toEqual(["last_active_at", "role"]);
  });

  it("gives accounts the own-row policy for every command and one more that adds the members of the active workspace to what a read shows", async () => {
    const policies = await db.owner<{ name: string; command: string }[]>`
      SELECT polname AS name, polcmd AS command FROM pg_policy WHERE polrelid = 'public.accounts'::regclass ORDER BY polname`;
    expect(policies).toEqual([
      { name: "accounts_tenant", command: "*" },
      { name: "accounts_tenant_co_members", command: "r" },
    ]);
  });

  it("keeps the secrets of an account out of reach of the application role, the account of a co-member included", async () => {
    const { workspaceId, members } = await workspaceOf("owner", "member");
    const [owner, member] = members;
    for (const column of ["password_hash", "mfa_secret", "mfa_secret_key_id", "mfa_last_step"]) {
      expect(await refusedWith(appAs({ accountId: owner?.accountId ?? "", workspaceId }, (tx) => tx.unsafe(`SELECT ${column} FROM accounts WHERE id = '${member?.accountId ?? ""}'`)))).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
    }
  });
});

describe("accounts and workspace_members as slugbase_app, row-level security alone", () => {
  it("shows an account its own row and the rows of the members of the workspace it acts in, and no other", async () => {
    const a = await workspaceOf("owner", "member");
    const b = await workspaceOf("owner", "member");
    const [aOwner] = a.members;
    const [bOwner] = b.members;
    const ids = (rows: readonly { id: string }[]): string[] => rows.map((row) => row.id).sort();

    const named = [...a.members, ...b.members].map((m) => m.accountId);
    const inA = await appAs({ accountId: aOwner?.accountId ?? "", workspaceId: a.workspaceId }, (tx) => tx<{ id: string }[]>`SELECT id FROM accounts WHERE id = ANY(${named}::uuid[])`);
    const accountLevel = await appAs({ accountId: aOwner?.accountId ?? "" }, (tx) => tx<{ id: string }[]>`SELECT id FROM accounts WHERE id = ANY(${named}::uuid[])`);
    const fromB = await appAs({ accountId: bOwner?.accountId ?? "", workspaceId: b.workspaceId }, (tx) => tx<{ id: string }[]>`SELECT id FROM accounts WHERE id = ANY(${named}::uuid[])`);

    expect(ids(inA)).toEqual(a.members.map((m) => m.accountId).sort());
    // an account-level transaction acts in no workspace, so the co-member branch names none
    expect(ids(accountLevel)).toEqual([aOwner?.accountId]);
    // acting in B, the account sees B's members and none of A's
    expect(ids(fromB)).toEqual(b.members.map((m) => m.accountId).sort());
  });

  it("lets an account change its own row and none of a co-member's", async () => {
    const { workspaceId, members } = await workspaceOf("owner", "member");
    const [owner, member] = members;

    const own = await appAs({ accountId: owner?.accountId ?? "", workspaceId }, (tx) => tx`UPDATE accounts SET display_name = 'Mine' WHERE id = ${owner?.accountId ?? ""}`);
    const theirs = await appAs({ accountId: owner?.accountId ?? "", workspaceId }, (tx) => tx`UPDATE accounts SET display_name = 'Hijacked' WHERE id = ${member?.accountId ?? ""}`);

    expect(own.count).toBe(1);
    expect(theirs.count).toBe(0);
    const rows = await asSystem(db, (tx) => tx<{ display_name: string }[]>`SELECT display_name FROM accounts WHERE id = ${member?.accountId ?? ""}`);
    expect(rows[0]?.display_name).toBe("Test account");
  });

  it("shows the members of the active workspace only and changes none of another workspace, whatever the statement names", async () => {
    const a = await workspaceOf("owner", "admin");
    const b = await workspaceOf("owner", "admin", "member");
    const [aOwner] = a.members;
    const before = await workspaceChecksum(db, b.workspaceId);
    const actor = { accountId: aOwner?.accountId ?? "", workspaceId: a.workspaceId };

    const listed = await appAs(actor, (tx) => tx`SELECT account_id FROM workspace_members WHERE workspace_id = ${b.workspaceId}`);
    const promoted = await appAs(actor, (tx) => tx`UPDATE workspace_members SET role = 'owner' WHERE workspace_id = ${b.workspaceId}`);
    const demoted = await appAs(actor, (tx) => tx`UPDATE workspace_members SET role = 'member' WHERE account_id = ${b.members[0]?.accountId ?? ""}`);
    const widened = await refusedWith(appAs(actor, (tx) => tx`UPDATE workspace_members SET workspace_id = ${b.workspaceId} WHERE workspace_id = ${a.workspaceId}`));
    const joined = await refusedWith(appAs(actor, (tx) => tx`INSERT INTO workspace_members (workspace_id, account_id, role) VALUES (${b.workspaceId}, ${aOwner?.accountId ?? ""}, 'owner')`));

    expect(listed).toHaveLength(0);
    expect(promoted.count).toBe(0);
    expect(demoted.count).toBe(0);
    expect(widened).toBe(INSUFFICIENT_PRIVILEGE);
    expect(joined).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await workspaceChecksum(db, b.workspaceId)).toBe(before);
  });
});

describe("memberRepository.list and member", () => {
  it("lists the members of the workspace with their account's display name and email and nothing else of the account, in the order of their account identifiers", async () => {
    const workspaceId = await seedWorkspace(db, { name: "Listing" });
    const joinedAt = new Date("2026-01-02T03:04:05.000Z");
    const lastActiveAt = new Date("2026-02-03T04:05:06.000Z");
    const ada = await account("Ada");
    const grace = await account("Grace");
    await seedMember(db, { workspaceId, accountId: ada, role: "owner", joinedAt, lastActiveAt });
    await seedMember(db, { workspaceId, accountId: grace, role: "member", joinedAt });
    const other = await workspaceOf("owner");

    const listed = await inTenant({ accountId: ada, workspaceId }, (tx) => memberRepository(tx).list(null, 10));

    expect(listed).toHaveLength(2);
    expect(listed.map((member) => member.accountId)).toEqual([ada, grace].sort());
    const adaRow = listed.find((member) => member.accountId === ada);
    expect(adaRow).toEqual({ accountId: ada, displayName: "Ada", email: expect.stringMatching(/^member\d+@example\.test$/) as string, role: "owner", joinedAt, lastActiveAt });
    expect(Object.keys(adaRow ?? {}).sort()).toEqual(["accountId", "displayName", "email", "joinedAt", "lastActiveAt", "role"]);
    expect(listed.find((member) => member.accountId === grace)?.lastActiveAt).toBeNull();
    expect(listed.some((member) => other.members.some((o) => o.accountId === member.accountId))).toBe(false);
  });

  it("pages after an account identifier", async () => {
    const { workspaceId, members } = await workspaceOf("owner", "admin", "member", "member");
    const ids = members.map((member) => member.accountId).sort();
    const caller = { accountId: members[0]?.accountId ?? "", workspaceId };

    const first = await inTenant(caller, (tx) => memberRepository(tx).list(null, 2));
    const second = await inTenant(caller, (tx) => memberRepository(tx).list(first.at(-1)?.accountId ?? null, 2));
    const third = await inTenant(caller, (tx) => memberRepository(tx).list(second.at(-1)?.accountId ?? null, 2));

    expect([...first, ...second].map((member) => member.accountId)).toEqual(ids);
    expect(third).toEqual([]);
  });

  it("reads one member of the workspace and none of another workspace or of no workspace", async () => {
    const a = await workspaceOf("owner", "member");
    const b = await workspaceOf("owner");
    const caller = { accountId: a.members[0]?.accountId ?? "", workspaceId: a.workspaceId };

    const own = await inTenant(caller, (tx) => memberRepository(tx).member(a.members[1]?.accountId ?? ""));
    const foreign = await inTenant(caller, (tx) => memberRepository(tx).member(b.members[0]?.accountId ?? ""));

    expect(own).toMatchObject({ accountId: a.members[1]?.accountId, role: "member" });
    expect(foreign).toBeUndefined();
  });

  it("needs a transaction opened with a workspace", async () => {
    const { members } = await workspaceOf("owner");

    await expect(inTenant({ accountId: members[0]?.accountId ?? "" }, (tx) => memberRepository(tx).list(null, 1))).rejects.toMatchObject({ code: "workspace_required" });
  });
});

describe("the constraint trigger that keeps an owner in every workspace", () => {
  it("refuses the commit of a transaction that demotes the last owner, and leaves the roles as they were", async () => {
    const { workspaceId, members } = await workspaceOf("owner", "admin");
    const [owner] = members;

    const error = await appAs({ accountId: owner?.accountId ?? "", workspaceId }, (tx) => setRole(tx, workspaceId, owner?.accountId ?? "", "admin")).catch((caught: unknown) => caught);

    expect(isLastOwnerViolation(error)).toBe(true);
    expect(error).toMatchObject({ code: CHECK_VIOLATION, constraint_name: "workspace_members_owner_required" });
    expect(await ownersOf(workspaceId)).toBe(1);
  });

  it("refuses the removal of the last owner and the move of its membership to another workspace", async () => {
    const { workspaceId, members } = await workspaceOf("owner", "member");
    const other = await workspaceOf("owner");
    const [owner] = members;

    const removed = await asSystem(db, (tx) => tx`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId} AND account_id = ${owner?.accountId ?? ""}`).catch((caught: unknown) => caught);
    const moved = await asSystem(db, (tx) => tx`UPDATE workspace_members SET workspace_id = ${other.workspaceId} WHERE workspace_id = ${workspaceId} AND account_id = ${owner?.accountId ?? ""}`).catch(
      (caught: unknown) => caught,
    );

    expect(isLastOwnerViolation(removed)).toBe(true);
    expect(isLastOwnerViolation(moved)).toBe(true);
    expect(await ownersOf(workspaceId)).toBe(1);
    expect(await ownersOf(other.workspaceId)).toBe(1);
  });

  it("lets an owner be demoted or removed while another owner remains", async () => {
    const { workspaceId, members } = await workspaceOf("owner", "owner", "owner");
    const [first, second, third] = members;

    await appAs({ accountId: first?.accountId ?? "", workspaceId }, (tx) => setRole(tx, workspaceId, second?.accountId ?? "", "admin"));
    await asSystem(db, (tx) => tx`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId} AND account_id = ${first?.accountId ?? ""}`);

    expect(await rolesOf(workspaceId)).toEqual({ [second?.accountId ?? ""]: "admin", [third?.accountId ?? ""]: "owner" });
  });

  it("judges the workspace when the transaction commits, so a transfer that demotes one owner after promoting another commits", async () => {
    const { workspaceId, members } = await workspaceOf("owner", "admin");
    const [owner, admin] = members;

    await appAs({ accountId: owner?.accountId ?? "", workspaceId }, async (tx) => {
      await setRole(tx, workspaceId, owner?.accountId ?? "", "admin");
      await setRole(tx, workspaceId, admin?.accountId ?? "", "owner");
    });

    expect(await rolesOf(workspaceId)).toEqual({ [owner?.accountId ?? ""]: "admin", [admin?.accountId ?? ""]: "owner" });
  });

  it("does not stop a change that leaves the owner an owner, such as last_active_at, or one that touches no owner", async () => {
    const { workspaceId, members } = await workspaceOf("owner", "member");

    await appAs({ accountId: members[0]?.accountId ?? "", workspaceId }, async (tx) => {
      await tx`UPDATE workspace_members SET last_active_at = now() WHERE workspace_id = ${workspaceId} AND account_id = ${members[0]?.accountId ?? ""}`;
      await setRole(tx, workspaceId, members[1]?.accountId ?? "", "admin");
    });

    expect(await ownersOf(workspaceId)).toBe(1);
  });

  it("does not guard a workspace being deleted or the deletion of the workspace itself, whose members go with it", async () => {
    const going = await workspaceOf("owner", "member");
    const gone = await workspaceOf("owner", "member");
    await asSystem(db, (tx) => tx`UPDATE workspaces SET deleting_at = now() WHERE id = ${going.workspaceId}`);

    await asSystem(db, (tx) => tx`DELETE FROM workspace_members WHERE workspace_id = ${going.workspaceId} AND account_id = ${going.members[0]?.accountId ?? ""}`);
    await asSystem(db, (tx) => tx`DELETE FROM workspaces WHERE id = ${gone.workspaceId}`);

    expect(await rolesOf(going.workspaceId)).toEqual({ [going.members[1]?.accountId ?? ""]: "member" });
    expect(await rolesOf(gone.workspaceId)).toEqual({});
  });

  it("leaves exactly one owner when two owners demote each other at the same moment", async () => {
    const { workspaceId, members } = await workspaceOf("owner", "owner");
    const [first, second] = members;

    const outcomes = await demoteEachOther(db.app, workspaceId, first?.accountId ?? "", second?.accountId ?? "");

    expect(outcomes.filter((outcome) => outcome === "committed")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "last_owner")).toHaveLength(1);
    expect(await ownersOf(workspaceId)).toBe(1);
  });

  it("leaves exactly one owner when many owners demote themselves at the same moment", async () => {
    const { workspaceId, members } = await workspaceOf("owner", "owner", "owner", "owner");

    const outcomes = await Promise.all(
      members.map((member, index) =>
        raced(db.app, workspaceId, members.length, index, async (tx) => {
          await setRole(tx, workspaceId, member.accountId, "member");
        }),
      ),
    );

    expect(outcomes.filter((outcome) => outcome === "committed")).toHaveLength(members.length - 1);
    expect(outcomes.filter((outcome) => outcome === "last_owner")).toHaveLength(1);
    expect(await ownersOf(workspaceId)).toBe(1);
  });
});

type Outcome = "committed" | "last_owner";

/**
 * Runs `change` in a transaction of its own as slugbase_app, holds it until `parties` transactions have made
 * their change, and only then lets them commit, so the commits (where the deferred trigger runs) overlap.
 */
const barriers = new Map<string, { arrived: number; release: () => void; open: Promise<void> }>();

function raced(pool: postgres.Sql, key: string, parties: number, _index: number, change: (tx: postgres.TransactionSql) => Promise<void>): Promise<Outcome> {
  let barrier = barriers.get(key);
  if (barrier === undefined) {
    let release: () => void = () => undefined;
    const open = new Promise<void>((resolve) => {
      release = resolve;
    });
    barrier = { arrived: 0, release, open };
    barriers.set(key, barrier);
  }
  const shared = barrier;
  return pool
    .begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${freshId()}, true), set_config('app.workspace_id', ${key}, true)`;
      await change(tx);
      shared.arrived += 1;
      if (shared.arrived === parties) {
        shared.release();
      }
      await shared.open;
    })
    .then(() => "committed" as const)
    .catch((error: unknown) => {
      if (isLastOwnerViolation(error)) {
        return "last_owner" as const;
      }
      throw error;
    });
}

function demoteEachOther(pool: postgres.Sql, workspaceId: string, first: string, second: string): Promise<[Outcome, Outcome]> {
  return Promise.all([
    raced(pool, workspaceId, 2, 0, async (tx) => {
      await setRole(tx, workspaceId, second, "admin");
    }),
    raced(pool, workspaceId, 2, 1, async (tx) => {
      await setRole(tx, workspaceId, first, "admin");
    }),
  ]);
}

describe("memberRepository.roles and setRole", () => {
  it("reads the roles of the caller and of the member under the lock of the workspace, and sets a role", async () => {
    const { workspaceId, members } = await workspaceOf("admin", "member");
    const [admin, member] = members;

    const result = await inTenant({ accountId: admin?.accountId ?? "", workspaceId }, async (tx) => {
      const repository = memberRepository(tx);
      const roles = await repository.roles(member?.accountId ?? "");
      const written = await repository.setRole(member?.accountId ?? "", "admin");
      return { roles, written, after: await repository.member(member?.accountId ?? "") };
    });

    expect(result.roles).toEqual({ actor: "admin", target: "member" });
    expect(result.written).toBe(true);
    expect(result.after?.role).toBe("admin");
    expect(await rolesOf(workspaceId)).toEqual({ [admin?.accountId ?? ""]: "admin", [member?.accountId ?? ""]: "admin" });
  });

  it("finds no target in another workspace and no workspace being deleted, and writes no role of either", async () => {
    const a = await workspaceOf("owner");
    const b = await workspaceOf("owner", "member");
    const going = await workspaceOf("owner", "member");
    await asSystem(db, (tx) => tx`UPDATE workspaces SET deleting_at = now() WHERE id = ${going.workspaceId}`);
    const before = await workspaceChecksum(db, b.workspaceId);

    const foreign = await inTenant({ accountId: a.members[0]?.accountId ?? "", workspaceId: a.workspaceId }, async (tx) => {
      const repository = memberRepository(tx);
      return { roles: await repository.roles(b.members[1]?.accountId ?? ""), written: await repository.setRole(b.members[1]?.accountId ?? "", "admin") };
    });
    const deleting = await inTenant({ accountId: going.members[0]?.accountId ?? "", workspaceId: going.workspaceId }, (tx) => memberRepository(tx).roles(going.members[1]?.accountId ?? ""));

    expect(foreign).toEqual({ roles: { actor: "owner", target: undefined }, written: false });
    expect(deleting).toBeUndefined();
    expect(await workspaceChecksum(db, b.workspaceId)).toBe(before);
  });

  it("queues two role changes of one workspace, so the second judges the roles the first left", async () => {
    const { workspaceId, members } = await workspaceOf("owner", "owner");
    const [first, second] = members;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstHasLocked: () => void = () => undefined;
    const locked = new Promise<void>((resolve) => {
      firstHasLocked = resolve;
    });
    const change = (actor: string, target: string, hold: boolean): Promise<string> =>
      inTenant({ accountId: actor, workspaceId }, async (tx) => {
        const outcome = await changeMemberRole(
          {
            store: {
              async roles(account) {
                const roles = await memberRepository(tx).roles(account);
                if (hold) {
                  firstHasLocked();
                  await gate;
                }
                return roles;
              },
              setRole: (account, role) => memberRepository(tx).setRole(account, role),
            },
            audit: createAuditWriter({ store: auditEventRepository(tx), newId: freshId }),
          },
          { workspaceId, actor: { type: "account", accountId: actor, label: "Actor" }, actorAccountId: actor, targetAccountId: target, role: "admin", ipPrefix: null },
        );
        return outcome.kind;
      });

    const winner = change(first?.accountId ?? "", second?.accountId ?? "", true);
    await locked;
    const loser = change(second?.accountId ?? "", first?.accountId ?? "", false);
    const early = await Promise.race([loser.then(() => "answered"), new Promise<string>((resolve) => setTimeout(() => { resolve("waiting"); }, 300))]);
    release();

    expect(early).toBe("waiting");
    expect(await winner).toBe("changed");
    // the second owner is an admin by the time it is judged, and an admin may not touch an owner
    expect(await loser).toBe("forbidden");
    expect(await rolesOf(workspaceId)).toEqual({ [first?.accountId ?? ""]: "owner", [second?.accountId ?? ""]: "admin" });
  });
});

describe("memberRepository.rotateSession", () => {
  async function sessionOf(accountId: string, level: "full" | "partial" = "full"): Promise<{ id: string; hash: Buffer }> {
    const { hash } = freshToken();
    const id = freshId();
    expect(
      await store.createSession({ id, accountId, level: "full", remember: false, ipPrefix: "203.0.0.0/16", userAgent: "Vitest", tokenHash: hash, replacedTokenHash: null }),
    ).toBe(true);
    if (level === "partial") {
      await asSystem(db, (tx) => tx`UPDATE sessions SET level = 'partial' WHERE id = ${id}`);
    }
    return { id, hash };
  }

  async function tokenOf(sessionId: string): Promise<Buffer | undefined> {
    const rows = await asSystem(db, (tx) => tx<{ token_hash: Buffer }[]>`SELECT token_hash FROM sessions WHERE id = ${sessionId}`);
    return rows[0]?.token_hash;
  }

  it("gives a full session of the account a new token", async () => {
    const { workspaceId, members } = await workspaceOf("owner");
    const caller = members[0]?.accountId ?? "";
    const session = await sessionOf(caller);
    const next = freshToken();

    const rotated = await inTenant({ accountId: caller, workspaceId }, (tx) => memberRepository(tx).rotateSession(session.id, next.hash));

    expect(rotated).toBe(true);
    expect(await tokenOf(session.id)).toEqual(next.hash);
  });

  it("changes no session of another account and no session that is still waiting for its second factor", async () => {
    const { workspaceId, members } = await workspaceOf("owner", "member");
    const [caller, other] = members;
    const theirs = await sessionOf(other?.accountId ?? "");
    const partial = await sessionOf(caller?.accountId ?? "", "partial");

    const results = await inTenant({ accountId: caller?.accountId ?? "", workspaceId }, async (tx) => [
      await memberRepository(tx).rotateSession(theirs.id, freshToken().hash),
      await memberRepository(tx).rotateSession(partial.id, freshToken().hash),
    ]);

    expect(results).toEqual([false, false]);
    expect(await tokenOf(theirs.id)).toEqual(theirs.hash);
    expect(await tokenOf(partial.id)).toEqual(partial.hash);
  });

  it("is undone with the transaction that asked for it", async () => {
    const { workspaceId, members } = await workspaceOf("owner");
    const caller = members[0]?.accountId ?? "";
    const session = await sessionOf(caller);

    await expect(
      inTenant({ accountId: caller, workspaceId }, async (tx) => {
        await memberRepository(tx).rotateSession(session.id, freshToken().hash);
        throw new Error("a later step failed");
      }),
    ).rejects.toThrow("a later step failed");

    expect(await tokenOf(session.id)).toEqual(session.hash);
  });
});

describe("the control for the concurrency tests", () => {
  it("would let both demotions commit if the function took no lock before it counted, which is why it takes one", async () => {
    // A copy of the function without the lock, with a pause so that both transactions are inside it together:
    // the two concurrency tests above only prove something if the demotions really overlap. The pause follows
    // the count and holds the result. The two commits are released together but reach the database a few
    // milliseconds apart; with the pause before the count, the first transaction could count and commit before
    // the second one counted, and the second would then find no other owner. With the count first, both count
    // while the other demotion is still uncommitted, and neither commits before its pause ends, so the overlap
    // is the whole pause and not the time one commit takes. It runs last because it replaces the function of
    // this test database.
    const { workspaceId, members } = await workspaceOf("owner", "owner");
    const [first, second] = members;
    await db.owner.unsafe(`
      CREATE OR REPLACE FUNCTION public.workspace_members_check_owner() RETURNS trigger
        LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
      DECLARE has_owner boolean;
      BEGIN
        IF OLD.role <> 'owner' THEN RETURN NULL; END IF;
        has_owner := EXISTS (SELECT 1 FROM public.workspace_members m WHERE m.workspace_id = OLD.workspace_id AND m.role = 'owner');
        PERFORM pg_sleep(0.5);
        IF NOT has_owner THEN
          RAISE EXCEPTION 'no owner' USING ERRCODE = 'check_violation', CONSTRAINT = 'workspace_members_owner_required';
        END IF;
        RETURN NULL;
      END $$`);

    const outcomes = await demoteEachOther(db.app, workspaceId, first?.accountId ?? "", second?.accountId ?? "");

    expect(outcomes).toEqual(["committed", "committed"]);
    expect(await ownersOf(workspaceId)).toBe(0);
  });
});
