import { AccountAccessModeError, setAccountAccessMode } from "@slugbase/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  accountAccessModeRepository,
  accountDeletionRepository,
  accountAccessModeTransaction,
  accountProfileRepository,
  createAccessModeStore,
  createAuthStore,
  instanceRepository,
  type AuthStore,
  type TenantTx,
} from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount, sessionRows } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// The export-only access mode of an account (doc 02 section 2.11, doc 05 sections 2.1 and 3.3, doc 10 T4 and T18). The failure
// scenarios: an account that can write its own mode or end date, a caller that is not an instance admin with a second factor that sets
// one, a mode set on an admin or a disabled account, an end date less than a day ahead, an end action applied twice or before its date,
// a deletion that leaves a workspace without its owner, and an audit event that holds anything of the account but its identifier.

const HOOK_TIMEOUT_MS = 300_000;
const TEST_TIMEOUT_MS = 60_000;
const INSUFFICIENT_PRIVILEGE = "42501";
const DAY_MS = 24 * 60 * 60 * 1000;

let db: TestDatabase;
let auth: AuthStore;

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
  auth = createAuthStore({ url: appUrl(db), poolSize: 2 });
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await auth.close();
  await db.drop();
}, HOOK_TIMEOUT_MS);

let emailNumber = 0;

async function account(options: { admin?: boolean; disabled?: boolean } = {}): Promise<string> {
  emailNumber += 1;
  const id = freshId();
  await seedAccount(db, {
    id,
    email: `access-mode${String(emailNumber)}@example.test`,
    passwordHash: "$argon2id$stub",
    isInstanceAdmin: options.admin === true,
    disabledAt: options.disabled === true ? new Date() : null,
    emailVerified: true,
  });
  if (options.admin === true) {
    await db.owner.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${id}, true)`;
      await tx`UPDATE accounts SET mfa_enabled_at = now(), mfa_secret = ${Buffer.from("sealed")}, mfa_secret_key_id = 'key-1' WHERE id = ${id}`;
    });
  }
  return id;
}

function withTenant<T>(accountId: string, work: (tx: TenantTx) => Promise<T>): Promise<T> {
  return db.tenant.withTenant({ accountId, requestId: "req-access-mode" }, work);
}

function errorCode(error: unknown): unknown {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth += 1) {
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (typeof code === "string") {
      return code;
    }
    current = cause;
  }
  return undefined;
}

async function codeOf(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return errorCode(error);
  }
  return undefined;
}

const inDays = (days: number): Date => new Date(Date.now() + days * DAY_MS);

interface ModeRow {
  access_mode: string;
  export_only_until: Date | null;
  export_only_end_action: string | null;
  disabled_at: Date | null;
}

async function modeOf(id: string): Promise<ModeRow> {
  const rows = await db.owner.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${id}, true)`;
    return tx<ModeRow[]>`SELECT access_mode, export_only_until, export_only_end_action, disabled_at FROM accounts WHERE id = ${id}`;
  });
  const [row] = rows;
  if (row === undefined) {
    throw new Error("the account is gone");
  }
  return row;
}

/** Puts the account in an export-only period whose end date has passed, the way a period that ran its course looks. */
async function endedPeriod(id: string, endAction: "disable" | "delete"): Promise<void> {
  await asSystem(
    db,
    (tx) => tx`UPDATE accounts SET access_mode = 'export_only', export_only_until = now() - interval '1 hour', export_only_end_action = ${endAction} WHERE id = ${id}`,
  );
}

async function events(action: string): Promise<{ id: string; actor_type: string; actor_account_id: string | null; entity_id: string | null; metadata: Record<string, unknown> }[]> {
  return asSystem(
    db,
    (tx) => tx`SELECT id, actor_type, actor_account_id, entity_id, metadata FROM audit_events WHERE workspace_id IS NULL AND action = ${action} ORDER BY created_at, id`,
  ).then((rows) => [...rows] as never);
}

async function instanceFlag(id: string): Promise<boolean> {
  const rows = await asSystem(db, (tx) => tx`SELECT is_instance_admin FROM accounts WHERE id = ${id}`);
  return (rows[0] as { is_instance_admin: boolean } | undefined)?.is_instance_admin === true;
}

async function countEvents(action: string): Promise<number> {
  return (await events(action)).length;
}

async function session(accountId: string): Promise<void> {
  await asSystem(
    db,
    (tx) => tx`
      INSERT INTO sessions (id, token_hash, account_id, level, remember, expires_at, absolute_expires_at)
      VALUES (${freshId()}, ${Buffer.alloc(32, accountId.length + Math.floor(Math.random() * 200))}, ${accountId}, 'full', false, now() + interval '1 day', now() + interval '2 days')`,
  );
}

describe("the columns", () => {
  it("default to full with no end date and no end action", async () => {
    const id = await account();
    expect(await modeOf(id)).toMatchObject({ access_mode: "full", export_only_until: null, export_only_end_action: null });
  });

  it("are neither readable nor writable by the application role, so an account cannot lift its own restriction or read another's", async () => {
    const id = await account();
    const attempt = (statement: string): Promise<unknown> =>
      codeOf(
        db.app.begin(async (tx) => {
          await tx`SELECT set_config('app.account_id', ${id}, true)`;
          await tx.unsafe(statement.replaceAll("$id", id));
        }),
      );
    expect(await attempt("UPDATE accounts SET access_mode = 'full' WHERE id = '$id'")).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await attempt("UPDATE accounts SET export_only_until = NULL WHERE id = '$id'")).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await attempt("UPDATE accounts SET export_only_end_action = 'delete' WHERE id = '$id'")).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await attempt("SELECT access_mode FROM accounts WHERE id = '$id'")).toBe(INSUFFICIENT_PRIVILEGE);
  });
});

describe("the instance admin setting the mode", () => {
  it("sets it with an end date and an end action, writes one event without content and tells the profile", async () => {
    const adminId = await account({ admin: true });
    const id = await account();
    const until = inDays(3);
    const eventId = freshId();
    const outcome = await withTenant(adminId, (tx) => instanceRepository(tx).setAccessMode(id, { mode: "exportOnly", until, endAction: "delete" }, eventId, null, []));
    expect(outcome).toBe("set");
    expect(await modeOf(id)).toMatchObject({ access_mode: "export_only", export_only_end_action: "delete" });
    expect((await modeOf(id)).export_only_until?.getTime()).toBe(until.getTime());
    const [event, ...rest] = (await events("instance.account_export_only_set")).filter((row) => row.entity_id === id);
    expect(rest).toEqual([]);
    expect(event).toMatchObject({ id: eventId, actor_type: "account", actor_account_id: adminId });
    expect(Object.keys(event?.metadata ?? {}).sort()).toEqual(["endAction", "until"]);
    const profile = await withTenant(id, (tx) => accountProfileRepository(tx).profile());
    expect(profile).toMatchObject({ accessMode: "exportOnly" });
    expect(profile?.exportOnlyUntil?.getTime()).toBe(until.getTime());
    const read = await auth.accountAccessMode(id);
    expect(read?.mode).toBe("exportOnly");
    expect(read?.mode === "exportOnly" ? read.until.getTime() : undefined).toBe(until.getTime());
    expect(await auth.accountAccessMode(freshId())).toBeUndefined();
  }, TEST_TIMEOUT_MS);

  it("lists the period with the account and reports the mode of one that is disabled as disabled", async () => {
    const adminId = await account({ admin: true });
    const id = await account();
    const disabled = await account({ disabled: true });
    await withTenant(adminId, (tx) => instanceRepository(tx).setAccessMode(id, { mode: "exportOnly", until: inDays(2), endAction: "disable" }, freshId(), null, []));
    const accounts = await withTenant(adminId, (tx) => instanceRepository(tx).listAccounts(freshId(), null));
    expect(accounts.find((row) => row.id === id)).toMatchObject({ accessMode: "exportOnly", exportOnlyEndAction: "disable", disabled: false });
    expect(accounts.find((row) => row.id === disabled)).toMatchObject({ accessMode: "disabled", exportOnlyUntil: null, exportOnlyEndAction: null });
    expect(accounts.find((row) => row.id === adminId)).toMatchObject({ accessMode: "full" });
  }, TEST_TIMEOUT_MS);

  it("refuses an end date less than a day ahead, an admin account and a disabled account, and writes nothing", async () => {
    const adminId = await account({ admin: true });
    const before = (await events("instance.account_export_only_set")).length;
    const plain = await account();
    const otherAdmin = await account({ admin: true });
    const disabled = await account({ disabled: true });
    const set = (id: string, until: Date): Promise<string> =>
      withTenant(adminId, (tx) => instanceRepository(tx).setAccessMode(id, { mode: "exportOnly", until, endAction: "disable" }, freshId(), null, []));
    expect(await set(plain, new Date(Date.now() + DAY_MS - 60_000))).toBe("until_too_soon");
    expect(await set(otherAdmin, inDays(5))).toBe("instance_admin");
    expect(await set(adminId, inDays(5))).toBe("instance_admin");
    expect(await set(disabled, inDays(5))).toBe("account_disabled");
    expect(await set(freshId(), inDays(5))).toBe("unknown_account");
    for (const id of [plain, otherAdmin, adminId, disabled]) {
      expect((await modeOf(id)).access_mode).toBe("full");
    }
    expect((await events("instance.account_export_only_set")).length).toBe(before);
  }, TEST_TIMEOUT_MS);

  it("refuses to grant the admin flag to an account in the period, writing nothing, and grants it again once the period is cleared", async () => {
    const adminId = await account({ admin: true });
    const id = await account();
    await session(id);
    const eventIds = { admin: freshId(), disabled: freshId(), verified: freshId() };
    expect(await withTenant(adminId, (tx) => instanceRepository(tx).setAccessMode(id, { mode: "exportOnly", until: inDays(5), endAction: "delete" }, freshId(), null, []))).toBe("set");
    const granted = (): Promise<{ kind: string }> => withTenant(adminId, (tx) => instanceRepository(tx).updateAccount(id, { isInstanceAdmin: true }, eventIds, null, []));
    const grantsBefore = await countEvents("instance.account_admin_granted");

    expect(await granted()).toEqual({ kind: "export_only" });

    expect(await instanceFlag(id)).toBe(false);
    expect(await modeOf(id)).toMatchObject({ access_mode: "export_only", export_only_end_action: "delete" });
    expect(await sessionRows(db, id)).toHaveLength(1);
    expect(await countEvents("instance.account_admin_granted")).toBe(grantsBefore);

    expect(await withTenant(adminId, (tx) => instanceRepository(tx).setAccessMode(id, { mode: "full" }, freshId(), null, []))).toBe("cleared");
    expect(await granted()).toMatchObject({ kind: "updated", adminChanged: true });
    expect(await instanceFlag(id)).toBe(true);
  }, TEST_TIMEOUT_MS);

  it("answers unchanged for the same period again, changes the end date, and clears it with one event", async () => {
    const adminId = await account({ admin: true });
    const id = await account();
    const until = inDays(4);
    const set = (to: Date, endAction: "disable" | "delete" = "disable"): Promise<string> =>
      withTenant(adminId, (tx) => instanceRepository(tx).setAccessMode(id, { mode: "exportOnly", until: to, endAction }, freshId(), null, []));
    expect(await set(until)).toBe("set");
    expect(await set(until)).toBe("unchanged");
    expect(await set(inDays(6))).toBe("set");
    const clear = (): Promise<string> => withTenant(adminId, (tx) => instanceRepository(tx).setAccessMode(id, { mode: "full" }, freshId(), null, []));
    expect(await clear()).toBe("cleared");
    expect(await clear()).toBe("unchanged");
    expect(await modeOf(id)).toMatchObject({ access_mode: "full", export_only_until: null, export_only_end_action: null });
    expect((await events("instance.account_export_only_cleared")).filter((row) => row.entity_id === id)).toHaveLength(1);
    expect((await events("instance.account_export_only_set")).filter((row) => row.entity_id === id)).toHaveLength(2);
  }, TEST_TIMEOUT_MS);

  it("raises, changing nothing, for a caller that is no instance admin with a second factor", async () => {
    const plain = await account();
    const noFactor = await account();
    await asSystem(db, (tx) => tx`UPDATE accounts SET is_instance_admin = true WHERE id = ${noFactor}`);
    const target = await account();
    for (const caller of [plain, noFactor]) {
      const code = await codeOf(withTenant(caller, (tx) => instanceRepository(tx).setAccessMode(target, { mode: "exportOnly", until: inDays(3), endAction: "disable" }, freshId(), null, [])));
      expect(code).toBe(INSUFFICIENT_PRIVILEGE);
    }
    expect((await modeOf(target)).access_mode).toBe("full");
  }, TEST_TIMEOUT_MS);
});

describe("the exported service for a composed deployment", () => {
  it("sets and clears the mode of the account of the transaction, with the system as the actor", async () => {
    const id = await account();
    const until = inDays(2);
    const set = await withTenant(id, (tx) => accountAccessModeRepository(tx).set({ eventId: freshId(), change: { mode: "exportOnly", until, endAction: "delete" } }));
    expect(set).toBe("set");
    expect((await modeOf(id)).access_mode).toBe("export_only");
    const [event] = (await events("instance.account_export_only_set")).filter((row) => row.entity_id === id);
    expect(event).toMatchObject({ actor_type: "system", actor_account_id: null });
    const cleared = await withTenant(id, (tx) => accountAccessModeTransaction(tx, freshId).setAccessMode({ eventId: freshId(), change: { mode: "full" } }));
    expect(cleared).toBe("cleared");
    expect((await modeOf(id)).access_mode).toBe("full");
  }, TEST_TIMEOUT_MS);

  it("is reached through the exported core service, which sets and clears the mode in the transaction a composition holds", async () => {
    const id = await account();
    const until = inDays(5);
    const result = await withTenant(id, (tx) => setAccountAccessMode(accountAccessModeTransaction(tx, freshId), { accountId: id, mode: "exportOnly", until, endAction: "disable" }));
    expect(result).toEqual({ outcome: "set" });
    expect(await modeOf(id)).toMatchObject({ access_mode: "export_only", export_only_end_action: "disable" });
    expect((await events("instance.account_export_only_set")).filter((row) => row.entity_id === id)).toHaveLength(1);
    expect(await withTenant(id, (tx) => setAccountAccessMode(accountAccessModeTransaction(tx, freshId), { accountId: id, mode: "exportOnly", until, endAction: "disable" }))).toEqual({ outcome: "unchanged" });
    expect(await withTenant(id, (tx) => setAccountAccessMode(accountAccessModeTransaction(tx, freshId), { accountId: id, mode: "full" }))).toEqual({ outcome: "cleared" });
    expect((await modeOf(id)).access_mode).toBe("full");
    // The service refuses a transaction that is not the account's, before asking the database anything.
    const other = await account();
    await expect(withTenant(id, (tx) => setAccountAccessMode(accountAccessModeTransaction(tx, freshId), { accountId: other, mode: "full" }))).rejects.toBeInstanceOf(AccountAccessModeError);
  }, TEST_TIMEOUT_MS);

  it("acts for no account but the one of the transaction, and in no workspace", async () => {
    const id = await account();
    const other = await account();
    const workspaceId = await seedWorkspace(db, { createdBy: id });
    await seedMember(db, { workspaceId, accountId: id, role: "owner" });
    const request = { eventId: freshId(), change: { mode: "exportOnly", until: inDays(2), endAction: "disable" } } as const;
    // The repository always names the account of its transaction; the function itself is what refuses another one.
    const foreign = await db.app.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${id}, true)`;
      return tx<{ outcome: string }[]>`
        SELECT public.sys_account_set_access_mode(${freshId()}::uuid, ${other}::uuid, 'export_only', ${request.change.until.toISOString()}::timestamptz, 'disable') AS outcome`;
    });
    expect(foreign[0]?.outcome).toBe("unknown_account");
    expect((await modeOf(other)).access_mode).toBe("full");
    const inWorkspace = await db.tenant.withTenant({ accountId: id, workspaceId, requestId: "req-access-mode" }, (tx) => accountAccessModeRepository(tx).set(request));
    expect(inWorkspace).toBe("unknown_account");
    expect((await modeOf(id)).access_mode).toBe("full");
  }, TEST_TIMEOUT_MS);

  it("refuses an admin, a disabled account and a date less than a day ahead as the instance admin's operation does", async () => {
    const adminId = await account({ admin: true });
    const disabled = await account({ disabled: true });
    const plain = await account();
    const set = (id: string, until: Date): Promise<string> =>
      withTenant(id, (tx) => accountAccessModeRepository(tx).set({ eventId: freshId(), change: { mode: "exportOnly", until, endAction: "delete" } }));
    expect(await set(adminId, inDays(3))).toBe("instance_admin");
    expect(await set(disabled, inDays(3))).toBe("account_disabled");
    expect(await set(plain, inDays(0.5))).toBe("until_too_soon");
  }, TEST_TIMEOUT_MS);
});

describe("the end of a period", () => {
  it("lists only the accounts whose end date has passed, oldest first, with their end action", async () => {
    const store = createAccessModeStore({ url: appUrl(db), poolSize: 1 });
    try {
      const due = await account();
      const notYet = await account();
      await endedPeriod(due, "delete");
      await asSystem(db, (tx) => tx`UPDATE accounts SET access_mode = 'export_only', export_only_until = now() + interval '2 days', export_only_end_action = 'disable' WHERE id = ${notYet}`);
      const listed = await store.due(1000);
      expect(listed).toContainEqual({ accountId: due, endAction: "delete" });
      expect(listed.map((row) => row.accountId)).not.toContain(notYet);
    } finally {
      await store.close();
    }
  }, TEST_TIMEOUT_MS);

  it("disables the account once: the sessions go, the mode is full again, a second run does nothing", async () => {
    const id = await account();
    await session(id);
    await endedPeriod(id, "disable");
    const eventId = freshId();
    const first = await withTenant(id, (tx) => accountAccessModeRepository(tx).end({ eventId, action: "disable", soleWorkspaceIds: [] }, []));
    expect(first).toBe("disabled");
    const row = await modeOf(id);
    expect(row).toMatchObject({ access_mode: "full", export_only_until: null, export_only_end_action: null });
    expect(row.disabled_at).not.toBeNull();
    expect(await sessionRows(db, id)).toEqual([]);
    const second = await withTenant(id, (tx) => accountAccessModeRepository(tx).end({ eventId: freshId(), action: "disable", soleWorkspaceIds: [] }, []));
    expect(second).toBe("not_due");
    expect((await events("instance.account_export_only_ended")).filter((event) => event.entity_id === id)).toHaveLength(1);
  }, TEST_TIMEOUT_MS);

  it("does nothing before the end date, for an account that is not export-only and for the wrong action", async () => {
    const early = await account();
    await asSystem(db, (tx) => tx`UPDATE accounts SET access_mode = 'export_only', export_only_until = now() + interval '2 days', export_only_end_action = 'delete' WHERE id = ${early}`);
    const full = await account();
    const disabling = await account();
    await endedPeriod(disabling, "disable");
    const end = (id: string, action: "disable" | "delete"): Promise<string> =>
      withTenant(id, (tx) => accountAccessModeRepository(tx).end({ eventId: freshId(), action, soleWorkspaceIds: [] }, []));
    expect(await end(early, "disable")).toBe("not_due");
    expect(await end(full, "disable")).toBe("not_due");
    expect(await end(disabling, "delete")).toBe("not_due");
    expect((await modeOf(early)).access_mode).toBe("export_only");
    expect((await modeOf(disabling)).access_mode).toBe("export_only");
    expect((await modeOf(disabling)).disabled_at).toBeNull();
  }, TEST_TIMEOUT_MS);

  it("deletes the account with the workspaces it is the only member of and keeps its content elsewhere ownerless", async () => {
    const id = await account();
    const other = await account();
    const solo = await seedWorkspace(db, { createdBy: id });
    await seedMember(db, { workspaceId: solo, accountId: id, role: "owner" });
    const shared = await seedWorkspace(db, { createdBy: other });
    await seedMember(db, { workspaceId: shared, accountId: other, role: "owner" });
    await seedMember(db, { workspaceId: shared, accountId: id, role: "member" });
    await endedPeriod(id, "delete");
    const deletionsBefore = (await events("instance.account_export_only_ended")).filter((row) => row.metadata["endAction"] === "delete").length;
    const outcome = await withTenant(id, async (tx) => {
      const repository = accountAccessModeRepository(tx);
      const scope = await accountDeletionRepository(tx).scope();
      expect(scope.soleMember.map((workspace) => workspace.id)).toEqual([solo]);
      return repository.end({ eventId: freshId(), action: "delete", soleWorkspaceIds: [solo] }, []);
    });
    expect(outcome).toBe("deleted");
    const rows = await asSystem(db, (tx) => tx`SELECT (SELECT count(*) FROM accounts WHERE id = ${id})::int AS accounts, (SELECT deleting_at FROM workspaces WHERE id = ${solo}) AS solo_deleting, (SELECT count(*) FROM workspace_members WHERE account_id = ${id})::int AS memberships`);
    expect(rows[0]).toMatchObject({ accounts: 0, memberships: 0 });
    expect(rows[0]?.["solo_deleting"]).not.toBeNull();
    const deletions = (await events("instance.account_export_only_ended")).filter((row) => row.metadata["endAction"] === "delete");
    expect(deletions).toHaveLength(deletionsBefore + 1);
    expect(deletions.at(-1)).toMatchObject({ actor_type: "system", actor_account_id: null, entity_id: null });
    const again = await withTenant(freshId(), (tx) => accountAccessModeRepository(tx).end({ eventId: freshId(), action: "delete", soleWorkspaceIds: [] }, []));
    expect(again).toBe("not_due");
  }, TEST_TIMEOUT_MS);

  it("leaves an account that is the only owner of a workspace with other members alone, so the caller can disable it", async () => {
    const id = await account();
    const other = await account();
    const workspaceId = await seedWorkspace(db, { createdBy: id });
    await seedMember(db, { workspaceId, accountId: id, role: "owner" });
    await seedMember(db, { workspaceId, accountId: other, role: "member" });
    await endedPeriod(id, "delete");
    const outcome = await withTenant(id, (tx) => accountAccessModeRepository(tx).end({ eventId: freshId(), action: "delete", soleWorkspaceIds: [] }, []));
    expect(outcome).toBe("blocked");
    expect(await modeOf(id)).toMatchObject({ access_mode: "export_only", disabled_at: null });
    expect(await withTenant(id, (tx) => accountAccessModeRepository(tx).end({ eventId: freshId(), action: "disable", soleWorkspaceIds: [] }, []))).toBe("disabled");
  }, TEST_TIMEOUT_MS);

  it("refuses a deletion whose list of sole workspaces is not the database's", async () => {
    const id = await account();
    const solo = await seedWorkspace(db, { createdBy: id });
    await seedMember(db, { workspaceId: solo, accountId: id, role: "owner" });
    await endedPeriod(id, "delete");
    const outcome = await withTenant(id, (tx) => accountAccessModeRepository(tx).end({ eventId: freshId(), action: "delete", soleWorkspaceIds: [] }, []));
    expect(outcome).toBe("unavailable");
    expect((await modeOf(id)).access_mode).toBe("export_only");
  }, TEST_TIMEOUT_MS);
});
