import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { goRepository, TenantContextError } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { seedTeam, shareBookmark, shareThroughFolder } from "./support/share-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// The slug suggestions of the palette's go mode (doc 02 section 9.2, doc 04 section 10.8, doc 05 sections 3.3 and 4, doc 10 T1, T2 and T12). The failure scenario: a prefix of `%`
// or `_` answers every slug of the workspace, or a slug of another workspace, of another member's private bookmark, of a bookmark that does not forward or of a plan-archived one is
// suggested. The system operation `sys_go_suggest` takes the workspace and the account from the transaction, and its candidates and access rule are those of the resolution of a slug.

const HOOK_TIMEOUT_MS = 300_000;

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
  await seedAccount(db, { id, email: `go-suggest${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub", emailVerified: true });
  return id;
}

async function workspace(name: string, members: readonly string[]): Promise<string> {
  const id = await seedWorkspace(db, { name });
  for (const accountId of members) {
    await seedMember(db, { workspaceId: id, accountId, role: "member" });
  }
  return id;
}

interface SeedOptions {
  readonly forwarding?: boolean;
  readonly archived?: boolean;
  readonly title?: string;
}

async function bookmark(workspaceId: string, ownerId: string | null, slug: string | null, options: SeedOptions = {}): Promise<string> {
  const id = freshId();
  await asSystem(
    db,
    (tx) => tx`
      INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, slug, forwarding, plan_archived_at)
      VALUES (${id}, ${workspaceId}, ${ownerId}, 'https://example.com/seed', 'https://example.com/seed', 'example.com', ${options.title ?? "Seed"}, ${slug},
              ${options.forwarding ?? slug !== null}, ${options.archived === true ? new Date() : null})`,
  );
  return id;
}

function suggest(workspaceId: string, accountId: string, prefix: string, limit = 10) {
  return db.tenant.withTenant({ accountId, workspaceId, requestId: "go-suggest-test" }, (tx) => goRepository(tx).suggest({ prefix, accountId, limit }));
}

async function slugs(workspaceId: string, accountId: string, prefix: string): Promise<string[]> {
  return (await suggest(workspaceId, accountId, prefix)).map((record) => record.slug);
}

describe("the suggestions of a prefix", () => {
  it("name the slugs of the caller's own forwarding bookmarks that start with it, with what the palette shows, by the bytes of the slug", async () => {
    const me = await account();
    const a = await workspace("A", [me]);
    const first = await bookmark(a, me, "m-notes", { title: "Notes" });
    const second = await bookmark(a, me, "m1");
    await bookmark(a, me, "mail", { title: "Mail" });
    await bookmark(a, me, "calendar");

    const found = await suggest(a, me, "m");

    expect(found.map((record) => record.slug)).toEqual(["m-notes", "m1", "mail"]);
    expect(found[0]).toEqual({ bookmarkId: first, slug: "m-notes", title: "Notes", host: "example.com", ownerId: me, ownerName: "Test account", access: "owner" });
    expect(found[1]?.bookmarkId).toBe(second);
    expect(await slugs(a, me, "mail")).toEqual(["mail"]);
    expect(await slugs(a, me, "mails")).toEqual([]);
  });

  it("leave out every bookmark the resolution of the slug would not name: another workspace's, another member's, one that does not forward, an archived one and one without an owner", async () => {
    const me = await account();
    const other = await account();
    const a = await workspace("A", [me, other]);
    const b = await workspace("B", [me]);
    const own = await bookmark(a, me, "go-own");
    await bookmark(b, me, "go-elsewhere");
    await bookmark(a, other, "go-theirs");
    await bookmark(a, me, "go-paused", { forwarding: false });
    await bookmark(a, me, "go-archived", { archived: true });
    await bookmark(a, null, "go-ownerless");
    await bookmark(a, me, null);

    const found = await suggest(a, me, "go");

    expect(found.map((record) => record.bookmarkId)).toEqual([own]);
    expect(await slugs(b, me, "go")).toEqual(["go-elsewhere"]);
    expect(await slugs(a, other, "go")).toEqual(["go-theirs"]);
  });

  it("take `%`, `_` and `\\` as the characters they are: no prefix with one of them matches every slug", async () => {
    const me = await account();
    const a = await workspace("A", [me]);
    await bookmark(a, me, "mail");
    await bookmark(a, me, "mbox");
    await bookmark(a, me, "m-x");

    for (const prefix of ["%", "_", "\\", "m%", "ma_l", "m_", "ma\\", "%ail", "_ail", "\\%", "\\_", "\\\\", "\\m", "\\ma", "m\\a", "\\mail"]) {
      expect(await slugs(a, me, prefix), prefix).toEqual([]);
    }
    expect(await slugs(a, me, "m")).toEqual(["m-x", "mail", "mbox"]);
  });

  it("order the candidates by the bytes of the slug, so the first fifty are the same in every database", async () => {
    const me = await account();
    const a = await workspace("A", [me]);
    for (let n = 1; n <= 55; n += 1) {
      await bookmark(a, me, `xb${String(n).padStart(2, "0")}`);
    }
    for (const slug of ["x-zz1", "x-zz2", "x-zz3"]) {
      await bookmark(a, me, slug);
    }

    expect((await slugs(a, me, "x")).slice(0, 5)).toEqual(["x-zz1", "x-zz2", "x-zz3", "xb01", "xb02"]);
  });

  it("read the prefix in lower case without the spaces around it, and answer nothing for an empty prefix, one longer than a slug and a NULL", async () => {
    const me = await account();
    const a = await workspace("A", [me]);
    await bookmark(a, me, "mail");

    expect(await slugs(a, me, "  MAI ")).toEqual(["mail"]);
    for (const prefix of ["", "   ", "m".repeat(65)]) {
      expect(await slugs(a, me, prefix), JSON.stringify(prefix)).toEqual([]);
    }
    const asked = await db.app.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${me}, true), set_config('app.workspace_id', ${a}, true)`;
      return tx<{ slug: string }[]>`SELECT slug FROM sys_go_suggest(NULL::text)`;
    });
    expect(asked).toEqual([]);
  });

  it("are at most ten, the first ten by slug", async () => {
    const me = await account();
    const a = await workspace("A", [me]);
    for (let n = 0; n < 13; n += 1) {
      await bookmark(a, me, `many-${String(n).padStart(2, "0")}`);
    }

    expect(await slugs(a, me, "many")).toEqual(Array.from({ length: 10 }, (_, n) => `many-${String(n).padStart(2, "0")}`));
    expect(await slugs(a, me, "many-1")).toEqual(["many-10", "many-11", "many-12"]);
  });

  it("find the caller's own among fifty and more candidates of other members and of bookmarks that are not theirs to read", async () => {
    const me = await account();
    const other = await account();
    const a = await workspace("A", [me, other]);
    await asSystem(
      db,
      (tx) => tx`
        INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, slug, forwarding)
        SELECT gen_random_uuid(), ${a}, ${other}, 'https://example.com/o' || n, 'https://example.com/o' || n, 'example.com', 'Theirs', 'crowd-' || lpad(n::text, 3, '0'), true
        FROM generate_series(1, 60) AS n`,
    );
    await bookmark(a, me, "crowd-zz");

    expect(await slugs(a, me, "crowd")).toEqual(["crowd-zz"]);
    expect(await slugs(a, other, "crowd-00")).toEqual(Array.from({ length: 9 }, (_, n) => `crowd-00${String(n + 1)}`));
  });

  it("order the caller's own first among the candidates, so a slug that sorts after fifty of another member's is still found", async () => {
    const me = await account();
    const other = await account();
    const a = await workspace("A", [me, other]);
    await asSystem(
      db,
      (tx) => tx`
        INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, slug, forwarding)
        SELECT gen_random_uuid(), ${a}, ${other}, 'https://example.com/o' || n, 'https://example.com/o' || n, 'example.com', 'Theirs', 'zz-' || lpad(n::text, 3, '0'), true
        FROM generate_series(1, 60) AS n`,
    );
    const mine = await bookmark(a, me, "zz-zzz");

    expect((await suggest(a, me, "zz")).map((record) => record.bookmarkId)).toEqual([mine]);
  });

  it("are asked for the account of the transaction only, with a whole limit up to ten, and only in a transaction opened with a workspace", async () => {
    const me = await account();
    const other = await account();
    const a = await workspace("A", [me, other]);

    await expect(db.tenant.withTenant({ accountId: me, workspaceId: a, requestId: "go-suggest-test" }, (tx) => goRepository(tx).suggest({ prefix: "m", accountId: other, limit: 10 }))).rejects.toThrow(
      "only the account of the transaction",
    );
    await expect(db.tenant.withTenant({ accountId: me, requestId: "go-suggest-test" }, (tx) => goRepository(tx).suggest({ prefix: "m", accountId: me, limit: 10 }))).rejects.toBeInstanceOf(TenantContextError);
    for (const limit of [0, 11, 1.5]) {
      await expect(suggest(a, me, "m", limit)).rejects.toThrow("whole limit");
    }
  });

  it("are cut to the limit asked", async () => {
    const me = await account();
    const a = await workspace("A", [me]);
    for (const slug of ["cut-a", "cut-b", "cut-c"]) {
      await bookmark(a, me, slug);
    }

    expect(await suggest(a, me, "cut", 2).then((found) => found.map((record) => record.slug))).toEqual(["cut-a", "cut-b"]);
  });
});

describe("the suggestions of slugs that others share with the caller (T12)", () => {
  it("name the caller's own first and then the shared ones by slug, with the owner and the route of each", async () => {
    const me = await account();
    const other = await account();
    const a = await workspace("A", [me, other]);
    const team = await seedTeam(db, a, [me]);
    const own = await bookmark(a, me, "go-zz-own");
    const direct = await bookmark(a, other, "go-a-direct", { title: "Direct" });
    const viaTeam = await bookmark(a, other, "go-b-team");
    const viaFolder = await bookmark(a, other, "go-c-folder");
    await shareBookmark(db, a, direct, other, { accountId: me });
    await shareBookmark(db, a, viaTeam, other, { teamId: team });
    await shareThroughFolder(db, a, viaFolder, other, { accountId: me });

    const found = await suggest(a, me, "go-");

    expect(found.map((record) => [record.bookmarkId, record.access])).toEqual([[own, "owner"], [direct, "direct"], [viaTeam, "team"], [viaFolder, "folder"]]);
    expect(found[1]).toEqual(expect.objectContaining({ slug: "go-a-direct", title: "Direct", host: "example.com", ownerId: other, ownerName: expect.any(String) as string }));
    expect(await slugs(a, other, "go-")).toEqual(["go-a-direct", "go-b-team", "go-c-folder"]);
  });

  it("leave out a shared bookmark that does not forward, an archived one, one shared with another member or with a team the caller is not in, and one shared in another workspace", async () => {
    const me = await account();
    const stranger = await account();
    const owner = await account();
    const a = await workspace("A", [me, stranger, owner]);
    const b = await workspace("B", [me, owner]);
    const otherTeam = await seedTeam(db, a, [stranger]);
    const shown = await bookmark(a, owner, "sh-shown");
    const paused = await bookmark(a, owner, "sh-paused", { forwarding: false });
    const archived = await bookmark(a, owner, "sh-archived", { archived: true });
    const forStranger = await bookmark(a, owner, "sh-stranger");
    const forTeam = await bookmark(a, owner, "sh-team");
    const inTeamsFolder = await bookmark(a, owner, "sh-folder");
    const elsewhere = await bookmark(b, owner, "sh-elsewhere");
    for (const id of [shown, paused, archived]) {
      await shareBookmark(db, a, id, owner, { accountId: me });
    }
    await shareBookmark(db, a, forStranger, owner, { accountId: stranger });
    await shareBookmark(db, a, forTeam, owner, { teamId: otherTeam });
    await shareThroughFolder(db, a, inTeamsFolder, owner, { teamId: otherTeam });
    await shareBookmark(db, b, elsewhere, owner, { accountId: me });

    expect(await slugs(a, me, "sh-")).toEqual(["sh-shown"]);
    expect(await slugs(b, me, "sh-")).toEqual(["sh-elsewhere"]);
    expect(await slugs(a, stranger, "sh-")).toEqual(["sh-folder", "sh-stranger", "sh-team"]);
  });

  it("find the shared ones among fifty and more candidates of other members that are not the caller's to read, and give the caller's own the places first", async () => {
    const me = await account();
    const other = await account();
    const owner = await account();
    const a = await workspace("A", [me, other, owner]);
    await asSystem(
      db,
      (tx) => tx`
        INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, slug, forwarding)
        SELECT gen_random_uuid(), ${a}, ${other}, 'https://example.com/o' || n, 'https://example.com/o' || n, 'example.com', 'Theirs', 'wide-' || lpad(n::text, 3, '0'), true
        FROM generate_series(1, 60) AS n`,
    );
    const shared = await bookmark(a, owner, "wide-zzz");
    await shareBookmark(db, a, shared, owner, { accountId: me });
    for (let n = 0; n < 10; n += 1) {
      await bookmark(a, me, `wide-own-${String(n)}`);
    }

    expect(await slugs(a, me, "wide-z")).toEqual(["wide-zzz"]);
    expect(await slugs(a, me, "wide")).toEqual(Array.from({ length: 10 }, (_, n) => `wide-own-${String(n)}`));
    expect((await slugs(a, owner, "wide-z"))).toEqual(["wide-zzz"]);
  });

  it("name a bookmark that two routes give once", async () => {
    const me = await account();
    const owner = await account();
    const a = await workspace("A", [me, owner]);
    const team = await seedTeam(db, a, [me]);
    const both = await bookmark(a, owner, "twice-1");
    await shareBookmark(db, a, both, owner, { teamId: team });
    await shareBookmark(db, a, both, owner, { accountId: me });
    await shareThroughFolder(db, a, both, owner, { accountId: me });

    expect((await suggest(a, me, "twice")).map((record) => [record.bookmarkId, record.access])).toEqual([[both, "direct"]]);
  });
});

describe("the system operation", () => {
  async function callAs(accountId: string | undefined, workspaceId: string | undefined, prefix: string): Promise<string[]> {
    const rows = await db.app.begin(async (tx) => {
      if (accountId !== undefined) {
        await tx`SELECT set_config('app.account_id', ${accountId}, true)`;
      }
      if (workspaceId !== undefined) {
        await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      }
      return tx<{ slug: string }[]>`SELECT slug FROM sys_go_suggest(${prefix}::text)`;
    });
    return rows.map((row) => row.slug);
  }

  it("is a SECURITY DEFINER function of slugbase_system with a pinned search_path and its plan pinned to bitmap scans, that slugbase_app, and nobody else, may execute", async () => {
    const [row] = await db.owner<{ definer: boolean; owner: string; config: string[]; app: boolean; pub: boolean; stable: boolean }[]>`
      SELECT p.prosecdef AS definer, pg_get_userbyid(p.proowner) AS owner, p.proconfig AS config, p.provolatile = 's' AS stable,
             has_function_privilege('slugbase_app', p.oid, 'EXECUTE') AS app, has_function_privilege('public', p.oid, 'EXECUTE') AS pub
      FROM pg_proc p WHERE p.oid = 'public.sys_go_suggest(text)'::regprocedure`;
    expect(row).toEqual({ definer: true, owner: "slugbase_system", config: ["search_path=pg_catalog, public, pg_temp", "enable_seqscan=off", "enable_indexscan=off", "enable_indexonlyscan=off"], stable: true, app: true, pub: false });
  });

  it("takes the workspace and the account from the transaction: it has no parameter for either, and answers nothing where one is not set", async () => {
    const me = await account();
    const a = await workspace("A", [me]);
    await bookmark(a, me, "mail");

    const [parameters] = await db.owner<{ args: string }[]>`SELECT pg_get_function_arguments('public.sys_go_suggest(text)'::regprocedure) AS args`;
    expect(parameters?.args).toBe("p_prefix text");
    expect(await callAs(me, a, "m")).toEqual(["mail"]);
    expect(await callAs(undefined, a, "m")).toEqual([]);
    expect(await callAs(me, undefined, "m")).toEqual([]);
  });

  it("answers an account its own bookmarks only, whichever account asked before it in the same pool", async () => {
    const me = await account();
    const other = await account();
    const a = await workspace("A", [me, other]);
    await bookmark(a, me, "pool-mine");
    await bookmark(a, other, "pool-theirs");

    expect(await callAs(me, a, "pool")).toEqual(["pool-mine"]);
    expect(await callAs(other, a, "pool")).toEqual(["pool-theirs"]);
    expect(await callAs(me, a, "pool")).toEqual(["pool-mine"]);
  });
});
