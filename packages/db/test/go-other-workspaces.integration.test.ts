import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { goRepository, TenantContextError } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// The other workspaces of a member in which a slug that resolves to nothing in the active workspace would resolve (doc 02 section 6.2 step 3.5, doc 05 sections 3.3
// and 4, doc 10 T1 and residual 8, Q26). The failure scenario: the same slug exists in workspace B, of which the caller is a member, in workspace C, of which the
// caller is not, and as another member's private bookmark in workspace D, of which the caller is a member; the lookup names B only. The system operation
// `sys_go_other_workspaces` takes the account from the transaction.

const HOOK_TIMEOUT_MS = 300_000;
const SLUG = "mail";

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await db.drop();
}, HOOK_TIMEOUT_MS);

let emailNumber = 0;
async function account(): Promise<string> {
  emailNumber += 1;
  const id = freshId();
  await seedAccount(db, { id, email: `go-other-workspaces${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub", emailVerified: true });
  return id;
}

async function workspace(name: string, members: readonly string[], deletingAt: Date | null = null): Promise<string> {
  const id = await seedWorkspace(db, { name, deletingAt });
  for (const accountId of members) {
    await seedMember(db, { workspaceId: id, accountId, role: "member" });
  }
  return id;
}

interface SeedOptions {
  readonly slug?: string;
  readonly forwarding?: boolean;
  readonly archived?: boolean;
}

async function bookmark(workspaceId: string, ownerId: string | null, options: SeedOptions = {}): Promise<string> {
  const id = freshId();
  const slug = options.slug ?? SLUG;
  await asSystem(
    db,
    (tx) => tx`
      INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, slug, forwarding, plan_archived_at)
      VALUES (${id}, ${workspaceId}, ${ownerId}, 'https://example.com/seed', 'https://example.com/seed', 'example.com', 'Seed', ${slug},
              ${options.forwarding ?? true}, ${options.archived === true ? new Date() : null})`,
  );
  return id;
}

function elsewhere(activeWorkspaceId: string, accountId: string, slug: string = SLUG) {
  return db.tenant.withTenant({ accountId, workspaceId: activeWorkspaceId, requestId: "go-other-workspaces-test" }, (tx) => goRepository(tx).otherWorkspaces({ slug, accountId }));
}

describe("the other workspaces of a slug", () => {
  it("name the workspace of which the caller is a member, not one of which the caller is not, and not one where the slug is only another member's private bookmark", async () => {
    const me = await account();
    const other = await account();
    const stranger = await account();
    const a = await workspace("A", [me]);
    const b = await workspace("B", [me]);
    const c = await workspace("C", [stranger]);
    const d = await workspace("D", [me, other]);
    await bookmark(b, me);
    await bookmark(c, stranger);
    await bookmark(d, other);

    expect(await elsewhere(a, me)).toEqual([{ id: b, name: "B" }]);
  });

  it("name nothing when the slug is in no other workspace, and never the workspace the request is in", async () => {
    const me = await account();
    const a = await workspace("A", [me]);
    const b = await workspace("B", [me]);
    await bookmark(a, me);
    await bookmark(b, me, { slug: "calendar" });

    expect(await elsewhere(a, me)).toEqual([]);
  });

  it("leave out a workspace where the caller's bookmark does not forward, is plan-archived, has another slug or has no owner", async () => {
    const me = await account();
    const a = await workspace("A", [me]);
    const paused = await workspace("Paused", [me]);
    const archived = await workspace("Archived", [me]);
    const renamed = await workspace("Renamed", [me]);
    const ownerless = await workspace("Ownerless", [me]);
    await bookmark(paused, me, { forwarding: false });
    await bookmark(archived, me, { archived: true });
    await bookmark(renamed, me, { slug: "mailbox" });
    await bookmark(ownerless, null);

    expect(await elsewhere(a, me)).toEqual([]);
  });

  it("leave out a workspace that is being deleted", async () => {
    const me = await account();
    const a = await workspace("A", [me]);
    const going = await workspace("Going", [me], new Date());
    const staying = await workspace("Staying", [me]);
    await bookmark(going, me);
    await bookmark(staying, me);

    expect(await elsewhere(a, me)).toEqual([{ id: staying, name: "Staying" }]);
  });

  it("name each workspace once, in the order of their names, at most twenty, whoever else in them has the slug", async () => {
    const me = await account();
    const a = await workspace("A", [me]);
    const names = Array.from({ length: 22 }, (_, index) => `W${String(index).padStart(2, "0")}`);
    const ids = new Map<string, string>();
    for (const name of [...names].reverse()) {
      const id = await workspace(name, [me]);
      ids.set(name, id);
      await bookmark(id, me);
    }
    // A workspace in which another member has the slug as well is named once.
    const sharer = await account();
    await seedMember(db, { workspaceId: ids.get("W00") as string, accountId: sharer, role: "member" });
    await bookmark(ids.get("W00") as string, sharer);

    const named = await elsewhere(a, me);

    expect(named).toHaveLength(20);
    expect(named.map((workspaceRow) => workspaceRow.name)).toEqual(names.slice(0, 20));
    expect(named.map((workspaceRow) => workspaceRow.id)).toEqual(names.slice(0, 20).map((name) => ids.get(name)));
  });

  it("name the workspaces of the caller whoever else in them has the slug, and each caller's own only", async () => {
    const me = await account();
    const other = await account();
    const a = await workspace("A", [me, other]);
    const b = await workspace("B", [me, other]);
    const c = await workspace("C", [other]);
    await bookmark(b, other);
    await bookmark(c, other);

    expect(await elsewhere(a, me)).toEqual([]);
    expect(await elsewhere(a, other)).toEqual([{ id: b, name: "B" }, { id: c, name: "C" }]);
  });

  it("are asked for the account of the transaction only, and only in a transaction opened with a workspace", async () => {
    const me = await account();
    const other = await account();
    const a = await workspace("A", [me, other]);

    await expect(db.tenant.withTenant({ accountId: me, workspaceId: a, requestId: "go-other-workspaces-test" }, (tx) => goRepository(tx).otherWorkspaces({ slug: SLUG, accountId: other }))).rejects.toThrow(
      "only the account of the transaction",
    );
    await expect(db.tenant.withTenant({ accountId: me, requestId: "go-other-workspaces-test" }, (tx) => goRepository(tx).otherWorkspaces({ slug: SLUG, accountId: me }))).rejects.toBeInstanceOf(TenantContextError);
  });
});

describe("the system operation", () => {
  async function callAs(accountId: string | undefined, workspaceId: string | undefined, slug: string | null): Promise<{ workspace_id: string; workspace_name: string }[]> {
    return db.app.begin(async (tx) => {
      if (accountId !== undefined) {
        await tx`SELECT set_config('app.account_id', ${accountId}, true)`;
      }
      if (workspaceId !== undefined) {
        await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      }
      return tx<{ workspace_id: string; workspace_name: string }[]>`SELECT workspace_id, workspace_name FROM sys_go_other_workspaces(${slug}::text)`;
    });
  }

  it("is a SECURITY DEFINER function of slugbase_system with a pinned search_path that slugbase_app, and nobody else, may execute", async () => {
    const [row] = await db.owner<{ definer: boolean; owner: string; config: string[]; app: boolean; pub: boolean; stable: boolean }[]>`
      SELECT p.prosecdef AS definer, pg_get_userbyid(p.proowner) AS owner, p.proconfig AS config, p.provolatile = 's' AS stable,
             has_function_privilege('slugbase_app', p.oid, 'EXECUTE') AS app, has_function_privilege('public', p.oid, 'EXECUTE') AS pub
      FROM pg_proc p WHERE p.oid = 'public.sys_go_other_workspaces(text)'::regprocedure`;
    expect(row).toEqual({ definer: true, owner: "slugbase_system", config: ["search_path=pg_catalog, public, pg_temp"], stable: true, app: true, pub: false });
  });

  it("takes the account from the transaction: it has no parameter for one, and answers nothing where none is set", async () => {
    const me = await account();
    const a = await workspace("A", [me]);
    const b = await workspace("B", [me]);
    await bookmark(b, me);

    const [parameters] = await db.owner<{ args: string }[]>`SELECT pg_get_function_arguments('public.sys_go_other_workspaces(text)'::regprocedure) AS args`;
    expect(parameters?.args).toBe("p_slug text");
    expect(await callAs(me, a, SLUG)).toEqual([{ workspace_id: b, workspace_name: "B" }]);
    expect(await callAs(undefined, a, SLUG)).toEqual([]);
    expect(await callAs(me, undefined, SLUG)).toEqual([]);
    expect(await callAs(me, a, null)).toEqual([]);
  });

  it("answers an account the workspaces of that account only, whichever account asked before it in the same pool", async () => {
    const me = await account();
    const other = await account();
    const a = await workspace("A", [me, other]);
    const mine = await workspace("Mine", [me, other]);
    const theirs = await workspace("Theirs", [other]);
    await bookmark(mine, me);
    await bookmark(theirs, other);

    expect(await callAs(me, a, SLUG)).toEqual([{ workspace_id: mine, workspace_name: "Mine" }]);
    expect(await callAs(other, a, SLUG)).toEqual([{ workspace_id: theirs, workspace_name: "Theirs" }]);
  });
});
