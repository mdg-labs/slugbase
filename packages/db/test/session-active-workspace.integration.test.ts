import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuthStore, workspaceRepository, type AuthStore, type NewSession } from "../src/index.ts";
import { tenantHandle } from "../src/tenant.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, freshToken, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// sys_session_set_active_workspace through workspaceRepository.setActive (doc 05 sections 2.1 and 3.3, doc 04
// section 10.4, doc 10 T1): the one way a session's active workspace is written. The failure scenarios: a session pointed at a workspace the
// account does not belong to (or one being deleted), a session of another account moved, and a partial
// session moved before its second factor is given. In each the session keeps its previous workspace.

const HOOK_TIMEOUT_MS = 300_000;

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

/** The switch as the route makes it: in an account-level transaction of the account that owns the session. */
function setActive(accountId: string, sessionId: string, workspaceId: string): Promise<boolean> {
  return db.tenant.withTenant({ accountId, requestId: "switch-test" }, (tx) => workspaceRepository(tx).setActive(sessionId, workspaceId));
}

let emailNumber = 0;
async function account(): Promise<string> {
  emailNumber += 1;
  const id = freshId();
  await seedAccount(db, { id, email: `switch${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub" });
  return id;
}

async function session(accountId: string, overrides: Partial<NewSession> = {}): Promise<{ id: string; hash: Buffer }> {
  const { hash } = freshToken();
  const id = freshId();
  const created = await store.createSession({
    id,
    accountId,
    level: "full",
    remember: false,
    ipPrefix: "203.0.0.0/16",
    userAgent: "Vitest",
    tokenHash: hash,
    replacedTokenHash: null,
    ...overrides,
  });
  expect(created).toBe(true);
  return { id, hash };
}

async function activeOf(sessionId: string): Promise<string | null> {
  const rows = await asSystem(db, (tx) => tx<{ active_workspace_id: string | null }[]>`SELECT active_workspace_id FROM sessions WHERE id = ${sessionId}`);
  const [row] = rows;
  if (row === undefined) {
    throw new Error("the session does not exist");
  }
  return row.active_workspace_id;
}

describe("sys_session_set_active_workspace", () => {
  it("moves a full session to a workspace the account is a member of", async () => {
    const alice = await account();
    const first = await seedWorkspace(db);
    const second = await seedWorkspace(db);
    await seedMember(db, { workspaceId: first, accountId: alice });
    await seedMember(db, { workspaceId: second, accountId: alice });
    const { id, hash } = await session(alice);

    expect(await setActive(alice, id, first)).toBe(true);
    expect(await activeOf(id)).toBe(first);
    expect(await setActive(alice, id, second)).toBe(true);
    expect(await activeOf(id)).toBe(second);
    expect((await store.lookupSession(hash))?.activeWorkspaceId).toBe(second);
  });

  it("refuses a workspace the account is not a member of and leaves the session where it was", async () => {
    const alice = await account();
    const bob = await account();
    const mine = await seedWorkspace(db);
    const theirs = await seedWorkspace(db);
    await seedMember(db, { workspaceId: mine, accountId: alice });
    await seedMember(db, { workspaceId: theirs, accountId: bob });
    const { id } = await session(alice);
    expect(await setActive(alice, id, mine)).toBe(true);

    expect(await setActive(alice, id, theirs)).toBe(false);
    expect(await setActive(alice, id, freshId())).toBe(false);
    expect(await activeOf(id)).toBe(mine);
  });

  it("refuses a workspace that is being deleted", async () => {
    const alice = await account();
    const live = await seedWorkspace(db);
    const dying = await seedWorkspace(db, { deletingAt: new Date() });
    await seedMember(db, { workspaceId: live, accountId: alice });
    await seedMember(db, { workspaceId: dying, accountId: alice });
    const { id } = await session(alice);
    expect(await setActive(alice, id, live)).toBe(true);

    expect(await setActive(alice, id, dying)).toBe(false);
    expect(await activeOf(id)).toBe(live);
  });

  it("does not move the session of another account, whatever workspace is named", async () => {
    const alice = await account();
    const bob = await account();
    const shared = await seedWorkspace(db);
    await seedMember(db, { workspaceId: shared, accountId: alice });
    await seedMember(db, { workspaceId: shared, accountId: bob });
    const aliceSession = await session(alice);

    expect(await setActive(bob, aliceSession.id, shared)).toBe(false);
    expect(await activeOf(aliceSession.id)).toBeNull();
  });

  it("does not move a partial session, whose second factor is still to be given", async () => {
    const alice = await account();
    const workspace = await seedWorkspace(db);
    await seedMember(db, { workspaceId: workspace, accountId: alice });
    const { id } = await session(alice);
    await asSystem(db, (tx) => tx`UPDATE sessions SET level = 'partial' WHERE id = ${id}`);

    expect(await setActive(alice, id, workspace)).toBe(false);
    expect(await activeOf(id)).toBeNull();
  });

  it("answers false for a session that does not exist", async () => {
    const alice = await account();
    const workspace = await seedWorkspace(db);
    await seedMember(db, { workspaceId: workspace, accountId: alice });

    expect(await setActive(alice, freshId(), workspace)).toBe(false);
  });

  it("does not move the session of another account from a transaction acting for an account, even when it names the session's own account", async () => {
    const alice = await account();
    const mallory = await account();
    const workspace = await seedWorkspace(db);
    await seedMember(db, { workspaceId: workspace, accountId: alice });
    await seedMember(db, { workspaceId: workspace, accountId: mallory });
    const { id } = await session(alice);

    const moved = await db.tenant.withTenant({ accountId: mallory, requestId: "switch-test" }, async (tx) => {
      const rows = await tenantHandle(tx).execute<{ moved: boolean }>(
        sql`SELECT public.sys_session_set_active_workspace(${id}::uuid, ${alice}::uuid, ${workspace}::uuid) AS moved`,
      );
      return rows[0]?.moved;
    });

    expect(moved).toBe(false);
    expect(await setActive(mallory, id, workspace)).toBe(false);
    expect(await activeOf(id)).toBeNull();
  });

  it("is not callable with an account, session or workspace left out", async () => {
    await expect(db.app`SELECT sys_session_set_active_workspace(NULL::uuid, ${freshId()}::uuid, ${freshId()}::uuid)`).rejects.toMatchObject({ code: "22023" });
    await expect(db.app`SELECT sys_session_set_active_workspace(${freshId()}::uuid, NULL::uuid, ${freshId()}::uuid)`).rejects.toMatchObject({ code: "22023" });
    await expect(db.app`SELECT sys_session_set_active_workspace(${freshId()}::uuid, ${freshId()}::uuid, NULL::uuid)`).rejects.toMatchObject({ code: "22023" });
  });
});
