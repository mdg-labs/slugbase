import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { searchRepository, TenantContextError } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// The search of a member's bookmarks, folders and tags (doc 02 section 9.1, doc 05 sections 2.4 and 3.3, doc 10 T1 and T2, Q49). The failure scenario: a query made of tsquery operators and
// LIKE wildcards answers without error and with sane results, and a member never gets back another member's private bookmark, a plan-archived bookmark or a row of another workspace.
// The system operation `sys_search` is the boundary of the bookmarks: it takes the workspace and the account from the transaction, never from an argument.

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
  await seedAccount(db, { id, email: `search${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub", emailVerified: true });
  return id;
}

async function workspace(members: readonly string[]): Promise<string> {
  const id = await seedWorkspace(db, { name: "Search test" });
  for (const accountId of members) {
    await seedMember(db, { workspaceId: id, accountId, role: "member" });
  }
  return id;
}

interface Seed {
  readonly title: string;
  readonly slug?: string | null;
  readonly host?: string;
  readonly description?: string | null;
  readonly forwarding?: boolean;
  readonly pinned?: boolean;
  readonly archived?: boolean;
}

async function bookmark(workspaceId: string, ownerId: string | null, seed: Seed): Promise<string> {
  const id = freshId();
  const host = seed.host ?? "example.com";
  await asSystem(
    db,
    (tx) => tx`
      INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, description, slug, forwarding, pinned_at, plan_archived_at)
      VALUES (${id}, ${workspaceId}, ${ownerId}, ${`https://${host}/${id}`}, ${`https://${host}/${id}`}, ${host}, ${seed.title}, ${seed.description ?? null}, ${seed.slug ?? null},
              ${seed.forwarding ?? false}, ${seed.pinned === true ? new Date() : null}, ${seed.archived === true ? new Date() : null})`,
  );
  return id;
}

async function folder(workspaceId: string, ownerId: string, name: string): Promise<string> {
  const id = freshId();
  await asSystem(db, (tx) => tx`INSERT INTO folders (id, workspace_id, owner_id, name) VALUES (${id}, ${workspaceId}, ${ownerId}, ${name})`);
  return id;
}

async function tag(workspaceId: string, ownerId: string, name: string): Promise<string> {
  const id = freshId();
  await asSystem(db, (tx) => tx`INSERT INTO tags (id, workspace_id, owner_id, name) VALUES (${id}, ${workspaceId}, ${ownerId}, ${name})`);
  return id;
}

function asMember<T>(workspaceId: string, accountId: string, work: Parameters<typeof db.tenant.withTenant<T>>[1]): Promise<T> {
  return db.tenant.withTenant({ accountId, workspaceId, requestId: "search-test" }, work);
}

async function callAs(accountId: string | undefined, workspaceId: string | undefined, text: string | null, limit = 20): Promise<{ id: string }[]> {
  return db.app.begin(async (tx) => {
    if (accountId !== undefined) {
      await tx`SELECT set_config('app.account_id', ${accountId}, true)`;
    }
    if (workspaceId !== undefined) {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    }
    return tx<{ id: string }[]>`SELECT id FROM sys_search(${text}::text, ${limit}::integer)`;
  });
}

async function found(workspaceId: string, accountId: string, text: string, limit = 20): Promise<string[]> {
  const hits = await asMember(workspaceId, accountId, (tx) => searchRepository(tx).bookmarks({ text, limit }));
  return hits.map((hit) => hit.id);
}

describe("the bookmarks of a search", () => {
  it("rank an exact slug, then a slug prefix, then full text, then trigram similarity, and answer what the search shows of each", async () => {
    const me = await account();
    const w = await workspace([me]);
    const exact = await bookmark(w, me, { title: "Zebra notes", slug: "git", forwarding: true, pinned: true, host: "notes.example.com" });
    const prefix = await bookmark(w, me, { title: "Yak farm", slug: "github" });
    const fullText = await bookmark(w, me, { title: "Learning Git the hard way", host: "books.example.com" });
    const typo = await bookmark(w, me, { title: "Gti cheatsheet" });
    await bookmark(w, me, { title: "Unrelated bookmark about cooking", slug: "cook" });

    expect(await found(w, me, "git")).toEqual([exact, prefix, fullText]);
    const hits = await asMember(w, me, (tx) => searchRepository(tx).bookmarks({ text: "git", limit: 20 }));
    expect(hits[0]).toEqual({ id: exact, title: "Zebra notes", url: expect.stringContaining("https://notes.example.com/") as string, host: "notes.example.com", slug: "git", forwarding: true, pinned: true });
    expect(hits[1]).toMatchObject({ id: prefix, slug: "github", forwarding: false, pinned: false });
    // A typo of a word of a title is found by trigram similarity, after everything the words match.
    expect(await found(w, me, "gti")).toContain(typo);
  });

  it("match a prefix of a word, the host, the slug as a word, and the description with less weight than the title", async () => {
    const me = await account();
    const w = await workspace([me]);
    const inTitle = await bookmark(w, me, { title: "Kubernetes handbook" });
    const inDescription = await bookmark(w, me, { title: "Reading list", description: "all about kubernetes clusters" });
    const onHost = await bookmark(w, me, { title: "Docs", host: "kubernetes.io" });

    expect(await found(w, me, "kuber")).toEqual([inTitle, onHost, inDescription]);
    expect(await found(w, me, "kubernetes.io")).toContain(onHost);
    expect(await found(w, me, "HANDBOOK")).toEqual([inTitle]);
  });

  it("tolerate a typo in a word of the title or the host by trigram similarity, which the default threshold of pg_trgm would not", async () => {
    const me = await account();
    const w = await workspace([me]);
    const inTitle = await bookmark(w, me, { title: "Kubernetes handbook" });
    const onHost = await bookmark(w, me, { title: "Docs", host: "stackoverflow.com" });
    await bookmark(w, me, { title: "Gardening calendar", host: "plants.example.org" });

    expect(await found(w, me, "kuberentes")).toEqual([inTitle]);
    expect(await found(w, me, "stackoverflw")).toEqual([onHost]);
  });

  it("rank the bookmarks that have every word of a longer query, in any order, before those that only resemble it", async () => {
    const me = await account();
    const w = await workspace([me]);
    const both = await bookmark(w, me, { title: "Alpha release notes for beta" });
    const one = await bookmark(w, me, { title: "Alpha only" });
    await bookmark(w, me, { title: "Something else entirely" });

    expect(await found(w, me, "beta alpha")).toEqual([both, one]);
  });

  it("fall back to the slug and the title prefix for a query of fewer than three characters", async () => {
    const me = await account();
    const w = await workspace([me]);
    const exact = await bookmark(w, me, { title: "Zed", slug: "gh" });
    const slugPrefix = await bookmark(w, me, { title: "Ghost", slug: "ghost" });
    const titlePrefix = await bookmark(w, me, { title: "GH archive" });
    await bookmark(w, me, { title: "Mid gh word" });
    await bookmark(w, me, { title: "Other", description: "gh in the description" });

    expect(await found(w, me, "gh")).toEqual([exact, slugPrefix, titlePrefix]);
    expect(await found(w, me, "G")).toEqual(expect.arrayContaining([exact, slugPrefix, titlePrefix]));
  });

  it("treat tsquery operators, wildcards, quotes and backslashes as plain text, without error and without matching everything", async () => {
    const me = await account();
    const w = await workspace([me]);
    const alpha = await bookmark(w, me, { title: "Alpha" });
    const beta = await bookmark(w, me, { title: "Beta" });
    const percent = await bookmark(w, me, { title: "100% pure" });
    const backslash = await bookmark(w, me, { title: String.raw`C:\temp files` });
    const quoted = await bookmark(w, me, { title: "It's Gamma" });

    // Operators are not read as operators: the answer of a query with `&`, `|`, `!`, `<->`, `:*` or parentheses is the answer of the same words without them.
    for (const [hostile, plain] of [["alpha | beta", "alpha beta"], ["alpha & beta", "alpha beta"], ["!alpha", "alpha"], ["alpha:*", "alpha"], ["(alpha)", "alpha"], ["bet:*", "bet"], ["alpha <-> beta", "alpha beta"], ["alpha&!beta", "alpha beta"]] as const) {
      expect(await found(w, me, hostile), hostile).toEqual(await found(w, me, plain));
    }
    expect(await found(w, me, "!alpha")).toEqual([alpha]);
    expect(await found(w, me, "bet:*")).toEqual([beta]);
    // LIKE wildcards are literal: `%` and `_` match nothing of their own, and only the title that holds the character is found by it.
    expect(await found(w, me, "%")).toEqual([]);
    expect(await found(w, me, "_")).toEqual([]);
    expect(await found(w, me, "%%%")).toEqual([]);
    expect(await found(w, me, "100%")).toEqual([percent]);
    expect(await found(w, me, "1%0")).toEqual([]);
    expect(await found(w, me, "al_ha")).toEqual([]);
    expect(await found(w, me, "\\")).toEqual([]);
    expect(await found(w, me, String.raw`c:\temp`)).toEqual([backslash]);
    // Quotes, unbalanced or not, and a statement, are text.
    for (const text of ["'", '"', "'alpha", 'alpha"', "it's", "gam'ma", "'; DROP TABLE bookmarks; --", "a\\", "((", "))", "&", "|", "!", ":*", "<->", "'' ''", "\\\\\\"]) {
      await expect(found(w, me, text), text).resolves.toBeInstanceOf(Array);
    }
    expect(await found(w, me, "it's")).toEqual([quoted]);
    expect(await found(w, me, "'alpha")).toEqual([alpha]);
    await expect(found(w, me, "alpha".repeat(40))).resolves.toBeInstanceOf(Array);
    expect(await found(w, me, "alpha ".repeat(40))).toEqual([alpha]);
  });

  it("find nothing for a query of no letters or digits and for white space", async () => {
    const me = await account();
    const w = await workspace([me]);
    await bookmark(w, me, { title: "Alpha", slug: "alpha" });

    expect(await found(w, me, "&&&")).toEqual([]);
    expect(await found(w, me, "   ")).toEqual([]);
  });

  it("never name a plan-archived bookmark, an ownerless one, another member's private bookmark or a bookmark of another workspace (T1, T2)", async () => {
    const me = await account();
    const other = await account();
    const stranger = await account();
    const w = await workspace([me, other]);
    const elsewhere = await workspace([me, stranger]);
    const mine = await bookmark(w, me, { title: "Secret plans mine", slug: "secret-mine" });
    await bookmark(w, me, { title: "Secret plans archived", slug: "secret-archived", archived: true });
    await bookmark(w, other, { title: "Secret plans theirs", slug: "secret-theirs" });
    await bookmark(w, null, { title: "Secret plans ownerless", slug: "secret-ownerless" });
    await bookmark(elsewhere, me, { title: "Secret plans in another workspace", slug: "secret-elsewhere" });
    await bookmark(elsewhere, stranger, { title: "Secret plans of a stranger", slug: "secret-stranger" });

    for (const text of ["secret", "secret-theirs", "secret plans", "secret-ownerless", "secre", "sec", "se", "plans", "scret"]) {
      const ids = await found(w, me, text);
      expect(ids.filter((id) => id !== mine), text).toEqual([]);
    }
    expect(await found(w, me, "secret")).toEqual([mine]);
    // The other member sees their own and not mine.
    expect(await found(w, other, "secret")).toHaveLength(1);
    expect(await found(w, other, "secret")).not.toContain(mine);
    // An account that owns nothing in the workspace finds nothing in it.
    expect(await found(w, stranger, "secret")).toEqual([]);
  });

  // One bookmark that no member may read, whose slug, title, host and description all hold the query, so that it satisfies the search condition of every branch of the system operation:
  // a branch that left out its owner or its archive predicate returns it. Each of the short and the long form has branches of its own, so each is asked with a query of its own.
  describe.each([
    { form: "short", text: "gh", slug: "gh", title: "Gh notes", host: "gh.example.com" },
    { form: "long", text: "gitlab", slug: "gitlab", title: "Gitlab", host: "gitlab.com" },
  ])("in the $form form", ({ text, slug, title, host }) => {
    it.each([
      { kind: "another member's", owner: "other", archived: false },
      { kind: "the caller's own plan-archived", owner: "me", archived: true },
      { kind: "another member's plan-archived", owner: "other", archived: true },
      { kind: "an ownerless", owner: "nobody", archived: false },
    ] as const)("is returned from no branch for $kind bookmark that matches the query in every branch (T1, T2)", async ({ owner, archived }) => {
      const me = await account();
      const other = await account();
      const w = await workspace([me, other]);
      const owners = { me, other, nobody: null };
      await bookmark(w, owners[owner], { title, slug, host, description: text, archived });
      // The caller's own bookmark that the query reaches by its title only, so the answer is not empty by accident.
      const mine = await bookmark(w, me, { title: `${text} mine`, slug: `${text}-mine-x`, host: "mine.example.com" });

      expect(await found(w, me, text)).toEqual([mine]);
    });
  });

  it("cap each answer at the limit and at twenty whatever limit is asked", async () => {
    const me = await account();
    const w = await workspace([me]);
    for (let n = 0; n < 25; n += 1) {
      await bookmark(w, me, { title: `Gamma report ${String(n).padStart(2, "0")}` });
    }

    expect(await found(w, me, "gamma", 3)).toHaveLength(3);
    expect(await found(w, me, "gamma", 20)).toHaveLength(20);
    expect(await callAs(me, w, "gamma", 500)).toHaveLength(20);
  });
});

describe("the folders and tags of a search", () => {
  it("name the caller's own, an exact name first, then a prefix, then the rest, and never another member's or another workspace's", async () => {
    const me = await account();
    const other = await account();
    const w = await workspace([me, other]);
    const elsewhere = await workspace([me]);
    const contains = await folder(w, me, "My reading list");
    const prefix = await folder(w, me, "Reading later");
    const exact = await folder(w, me, "reading");
    await folder(w, other, "Reading of theirs");
    await folder(elsewhere, me, "Reading in another workspace");
    const tagContains = await tag(w, me, "deep-reading");
    const tagExact = await tag(w, me, "Reading");
    await tag(w, other, "reading-theirs");
    await tag(elsewhere, me, "reading-elsewhere");

    const result = await asMember(w, me, async (tx) => ({
      folders: await searchRepository(tx).folders({ accountId: me, text: "reading", limit: 4 }),
      tags: await searchRepository(tx).tags({ accountId: me, text: "reading", limit: 4 }),
    }));

    expect(result.folders.map((entry) => entry.id)).toEqual([exact, prefix, contains]);
    expect(result.folders[0]).toEqual({ id: exact, name: "reading", icon: "folder", color: 1 });
    expect(result.tags).toEqual([
      { id: tagExact, name: "Reading" },
      { id: tagContains, name: "deep-reading" },
    ]);
  });

  it("read the characters of LIKE as text", async () => {
    const me = await account();
    const w = await workspace([me]);
    const percent = await folder(w, me, "50% off");
    await folder(w, me, "Fifty off");
    const underscore = await tag(w, me, "a_b");
    await tag(w, me, "axb");

    const result = await asMember(w, me, async (tx) => ({
      folders: await searchRepository(tx).folders({ accountId: me, text: "50%", limit: 4 }),
      all: await searchRepository(tx).folders({ accountId: me, text: "%", limit: 4 }),
      tags: await searchRepository(tx).tags({ accountId: me, text: "a_b", limit: 4 }),
      backslash: await searchRepository(tx).tags({ accountId: me, text: "\\", limit: 4 }),
    }));

    expect(result.folders.map((entry) => entry.id)).toEqual([percent]);
    expect(result.all.map((entry) => entry.id)).toEqual([percent]);
    expect(result.tags.map((entry) => entry.id)).toEqual([underscore]);
    expect(result.backslash).toEqual([]);
  });

  it("are asked for the account of the transaction only, and only in a transaction opened with a workspace", async () => {
    const me = await account();
    const other = await account();
    const w = await workspace([me, other]);

    await expect(asMember(w, me, (tx) => searchRepository(tx).folders({ accountId: other, text: "x", limit: 4 }))).rejects.toThrow("for the account of the transaction only");
    await expect(asMember(w, me, (tx) => searchRepository(tx).tags({ accountId: other, text: "x", limit: 4 }))).rejects.toThrow("for the account of the transaction only");
    await expect(db.tenant.withTenant({ accountId: me, requestId: "search-test" }, (tx) => searchRepository(tx).bookmarks({ text: "x", limit: 4 }))).rejects.toBeInstanceOf(TenantContextError);
  });
});

describe("the system operation", () => {
  it("is a SECURITY DEFINER function of slugbase_system with a pinned search_path that slugbase_app, and nobody else, may execute", async () => {
    const [row] = await db.owner<{ definer: boolean; owner: string; config: string[]; app: boolean; pub: boolean; stable: boolean }[]>`
      SELECT p.prosecdef AS definer, pg_get_userbyid(p.proowner) AS owner, p.proconfig AS config, p.provolatile = 's' AS stable,
             has_function_privilege('slugbase_app', p.oid, 'EXECUTE') AS app, has_function_privilege('public', p.oid, 'EXECUTE') AS pub
      FROM pg_proc p WHERE p.oid = 'public.sys_search(text, integer)'::regprocedure`;
    expect(row).toMatchObject({ definer: true, owner: "slugbase_system", stable: true, app: true, pub: false });
    expect(row?.config).toContain("search_path=pg_catalog, public, pg_temp");
  });

  it("has no parameter for a workspace or an account, and answers nothing where none is set", async () => {
    const me = await account();
    const w = await workspace([me]);
    const hit = await bookmark(w, me, { title: "Gamma", slug: "gamma" });

    const [parameters] = await db.owner<{ args: string }[]>`SELECT pg_get_function_arguments('public.sys_search(text, integer)'::regprocedure) AS args`;
    expect(parameters?.args).toBe("p_query text, p_limit integer");
    expect(await callAs(me, w, "gamma")).toEqual([{ id: hit }]);
    expect(await callAs(undefined, w, "gamma")).toEqual([]);
    expect(await callAs(me, undefined, "gamma")).toEqual([]);
    expect(await callAs(me, w, null)).toEqual([]);
    expect(await callAs(me, w, "gamma", 0)).toEqual([]);
    expect(await callAs(me, w, "gamma", -5)).toEqual([]);
  });

  it("cannot be steered to another workspace or another member's bookmark: it answers the account and the workspace of the transaction, whoever asked before in the same pool", async () => {
    const me = await account();
    const other = await account();
    const a = await workspace([me, other]);
    const b = await workspace([other]);
    const mine = await bookmark(a, me, { title: "Delta mine", slug: "delta-mine" });
    const theirs = await bookmark(a, other, { title: "Delta theirs", slug: "delta-theirs" });
    const inB = await bookmark(b, other, { title: "Delta in b", slug: "delta-b" });

    expect(await callAs(me, a, "delta")).toEqual([{ id: mine }]);
    expect(await callAs(other, a, "delta")).toEqual([{ id: theirs }]);
    expect(await callAs(other, b, "delta")).toEqual([{ id: inB }]);
    // The settings name a workspace the account is no member of: the policies of the other tables are not asked, so the operation itself finds no bookmark of the account there.
    expect(await callAs(me, b, "delta")).toEqual([]);
    expect(await callAs(me, a, "delta")).toEqual([{ id: mine }]);
  });
});
