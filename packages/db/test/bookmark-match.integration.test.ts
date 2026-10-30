import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { searchRepository } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { seedTeam, shareBookmark, shareThroughFolder } from "./support/share-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// The matches of the text query of the bookmark list (doc 02 sections 5.7 and 9.1, doc 05 sections 2.4 and 3.3, doc 10 T1 and T2). The system operation `sys_bookmark_match` answers the identifiers
// of the bookmarks the caller can read (their own and those shared with them) that are not plan-archived and whose slug, title, host or description the text matches, as the search of `sys_search` matches them, and is the boundary of the list: it takes the
// workspace and the account from the transaction, never from an argument. The failure scenarios: a bookmark of another member, a plan-archived one, an ownerless one or one of another workspace
// that is returned from a branch that left out its predicate, and a list whose matches are not those of the search.

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
  await seedAccount(db, { id, email: `bookmark-match${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub", emailVerified: true });
  return id;
}

async function workspace(members: readonly string[]): Promise<string> {
  const id = await seedWorkspace(db, { name: "Bookmark match test" });
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
  readonly archived?: boolean;
}

async function bookmark(workspaceId: string, ownerId: string | null, seed: Seed): Promise<string> {
  const id = freshId();
  const host = seed.host ?? "example.com";
  await asSystem(
    db,
    (tx) => tx`
      INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, description, slug, forwarding, plan_archived_at)
      VALUES (${id}, ${workspaceId}, ${ownerId}, ${`https://${host}/${id}`}, ${`https://${host}/${id}`}, ${host}, ${seed.title}, ${seed.description ?? null}, ${seed.slug ?? null},
              ${seed.slug === undefined || seed.slug === null ? false : true}, ${seed.archived === true ? new Date() : null})`,
  );
  return id;
}

/** The matches of `text` as slugbase_app sees them, with the account and the workspace given (either may be left unset). */
async function matches(accountId: string | undefined, workspaceId: string | undefined, text: string | null): Promise<string[]> {
  const rows = await db.app.begin(async (tx) => {
    if (accountId !== undefined) {
      await tx`SELECT set_config('app.account_id', ${accountId}, true)`;
    }
    if (workspaceId !== undefined) {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    }
    return tx<{ id: string }[]>`SELECT id FROM sys_bookmark_match(${text}::text)`;
  });
  return rows.map((row) => row.id);
}

async function found(workspaceId: string, accountId: string, text: string): Promise<string[]> {
  return (await matches(accountId, workspaceId, text)).toSorted();
}

describe("the matches of a text query", () => {
  it("are the bookmarks whose slug starts with the text or whose slug, title, host or description hold every word of it as a prefix, and none for a word nothing holds", async () => {
    const me = await account();
    const w = await workspace([me]);
    const bySlug = await bookmark(w, me, { title: "Zebra notes", slug: "kube-notes" });
    const byTitle = await bookmark(w, me, { title: "Kubernetes handbook" });
    const byHost = await bookmark(w, me, { title: "Docs", host: "kubernetes.io" });
    const byDescription = await bookmark(w, me, { title: "Reading list", description: "all about kubernetes clusters" });
    const unrelated = await bookmark(w, me, { title: "Cooking", slug: "cook" });

    expect(await found(w, me, "kube")).toEqual([bySlug, byTitle, byHost, byDescription].toSorted());
    expect(await found(w, me, "KUBERNETES")).toEqual([byTitle, byHost, byDescription].toSorted());
    expect(await found(w, me, "kubernetes handbook")).toEqual([byTitle]);
    expect(await found(w, me, "handbook   kubernetes")).toEqual([byTitle]);
    expect(await found(w, me, "kube-notes")).toEqual([bySlug]);
    expect(await found(w, me, "cook")).toEqual([unrelated]);
    expect(await found(w, me, "zzzzqqq")).toEqual([]);
  });

  it("do not search the path of the URL", async () => {
    const me = await account();
    const w = await workspace([me]);
    const id = freshId();
    await asSystem(
      db,
      (tx) => tx`
        INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title)
        VALUES (${id}, ${w}, ${me}, 'https://example.com/pathsegment/deep', 'https://example.com/pathsegment/deep', 'example.com', 'Untitled')`,
    );

    expect(await found(w, me, "pathsegment")).toEqual([]);
    expect(await found(w, me, "example")).toEqual([id]);
  });

  it("match a text of fewer than three characters by the start of the slug or the title only", async () => {
    const me = await account();
    const w = await workspace([me]);
    const slug = await bookmark(w, me, { title: "Zzz", slug: "gh" });
    const slugStart = await bookmark(w, me, { title: "Zzz", slug: "ghost" });
    const title = await bookmark(w, me, { title: "GH notes" });
    await bookmark(w, me, { title: "Notes on gh", host: "gh.example.com", description: "gh" });

    expect(await found(w, me, "gh")).toEqual([slug, slugStart, title].toSorted());
    expect(await found(w, me, "g")).toEqual([slug, slugStart, title].toSorted());
    expect(await found(w, me, "h")).toEqual([]);
  });

  it("give a typo its bookmark only when no bookmark holds the words, so a word that merely resembles the text stays out of a list of those that hold it", async () => {
    const me = await account();
    const w = await workspace([me]);
    const kubernetes = await bookmark(w, me, { title: "Kubernetes handbook" });
    const onHost = await bookmark(w, me, { title: "Docs", host: "stackoverflow.com" });
    const read = await bookmark(w, me, { title: "Read the docs" });
    const react = await bookmark(w, me, { title: "React patterns" });

    expect(await found(w, me, "kubenetes")).toEqual([kubernetes]);
    expect(await found(w, me, "stackoverflw")).toEqual([onHost]);
    // `reac` is a prefix of a word of one title, and is as like a word of another as a typo is: only the first holds it.
    expect(await found(w, me, "reac")).toEqual([react]);
    expect(await found(w, me, "reac")).not.toContain(read);
  });

  it("treat query syntax as plain text and fail on none of it", async () => {
    const me = await account();
    const w = await workspace([me]);
    const plain = await bookmark(w, me, { title: "Notes & drafts (v2)", slug: "notes-v2" });
    const percent = await bookmark(w, me, { title: "Percent 100% done", slug: "pct" });

    for (const text of ["&", "|", "!", ":*", "'", "\\", "%", "_", "a & b | !c", "'; DROP TABLE bookmarks; --", "((", "notes:*", "notes & !drafts"]) {
      await expect(matches(me, w, text), text).resolves.toBeInstanceOf(Array);
    }
    expect(await found(w, me, "notes & drafts")).toEqual([plain]);
    expect(await found(w, me, "100%")).toEqual([percent]);
    // A wildcard is never one: neither `%` nor `_` reaches every slug.
    expect(await found(w, me, "%%%")).toEqual([]);
    expect(await found(w, me, "___")).toEqual([]);
  });

  it("are none for an empty or blank text, a null text and a transaction without an account or without a workspace", async () => {
    const me = await account();
    const w = await workspace([me]);
    await bookmark(w, me, { title: "Anything", slug: "any" });

    expect(await matches(me, w, "")).toEqual([]);
    expect(await matches(me, w, "   ")).toEqual([]);
    expect(await matches(me, w, null)).toEqual([]);
    expect(await matches(undefined, w, "anything")).toEqual([]);
    expect(await matches(me, undefined, "anything")).toEqual([]);
    expect(await matches(undefined, undefined, "anything")).toEqual([]);
    expect(await matches(me, w, "anything")).toHaveLength(1);
  });

  it("cut a long text to its first hundred characters", async () => {
    const me = await account();
    const w = await workspace([me]);
    const id = await bookmark(w, me, { title: `${"a".repeat(98)} tail` });

    expect(await found(w, me, `${"a".repeat(98)} tail ${"zzz ".repeat(50)}`)).toEqual([id]);
  });
});

describe("the matches of a text query for the bookmarks no member may read (T1, T2)", () => {
  // One bookmark that the caller may not read, whose slug, title, host and description all hold the text, so that it satisfies the condition of every branch of the system operation: a branch
  // that left out its owner or its archive predicate returns it. The short form has branches of its own, so it is asked with a text of its own.
  describe.each([
    { form: "short", text: "gh", slug: "gh", title: "Gh notes", host: "gh.example.com" },
    { form: "long", text: "gitlab", slug: "gitlab", title: "Gitlab", host: "gitlab.com" },
  ])("in the $form form", ({ text, slug, title, host }) => {
    it.each([
      { kind: "another member's", owner: "other", archived: false },
      { kind: "the caller's own plan-archived", owner: "me", archived: true },
      { kind: "another member's plan-archived", owner: "other", archived: true },
      { kind: "an ownerless", owner: "nobody", archived: false },
    ] as const)("returns from no branch $kind bookmark that matches the text in every branch", async ({ owner, archived }) => {
      const me = await account();
      const other = await account();
      const w = await workspace([me, other]);
      const owners = { me, other, nobody: null };
      await bookmark(w, owners[owner], { title, slug, host, description: text, archived });
      // The caller's own bookmark that the text reaches, so the answer is not empty by accident.
      const mine = await bookmark(w, me, { title: `${text} mine`, slug: `${text}-mine-x`, host: "mine.example.com" });

      expect(await found(w, me, text)).toEqual([mine]);
    });
  });

  // The host and description matches of the long form are read by their own branch of the full-text index: a bookmark whose title and slug do not hold the text.
  describe.each([
    { kind: "another member's", owner: "other", archived: false },
    { kind: "the caller's own plan-archived", owner: "me", archived: true },
    { kind: "another member's plan-archived", owner: "other", archived: true },
    { kind: "an ownerless", owner: "nobody", archived: false },
  ] as const)("in the long form for $kind bookmark", ({ owner, archived }) => {
    it.each([
      { where: "host", host: "ptarmigan.example.com", description: null },
      { where: "description", host: "example.com", description: "about the ptarmigan" },
    ])("is not returned when only its $where holds the text", async ({ host, description }) => {
      const me = await account();
      const other = await account();
      const w = await workspace([me, other]);
      const owners = { me, other, nobody: null };
      await bookmark(w, owners[owner], { title: "Untitled", host, description, archived });
      const mine = await bookmark(w, me, { title: "Notes", host, description });

      expect(await found(w, me, "ptarmigan")).toEqual([mine]);
    });

    // The typo matches are read by the trigram indexes of the title and of the host, which run when nothing else matches: the bookmark that no member may read resembles the text by both, and the
    // caller has no bookmark that holds it.
    it.each([
      { where: "title", host: "example.com", title: "Ptarmigan" },
      { where: "host", host: "ptarmigan.example.com", title: "Untitled" },
    ])("is not returned when it resembles the text by its $where alone and the caller has none that holds it", async ({ host, title }) => {
      const me = await account();
      const other = await account();
      const w = await workspace([me, other]);
      const owners = { me, other, nobody: null };
      await bookmark(w, owners[owner], { title, host, archived });
      const mine = await bookmark(w, me, { title: title === "Ptarmigan" ? "Ptarmigam" : "Untitled", host: title === "Ptarmigan" ? "example.com" : "ptarmigam.example.com" });

      expect(await found(w, me, "ptarmigan")).toEqual([mine]);
    });
  });

  // The matches of every branch are those of the active workspace alone, whatever the member has in another one: the caller's own bookmark of the other workspace satisfies the condition.
  it.each([
    { branch: "slug prefix", text: "heron", elsewhere: { title: "Aaa", slug: "heron-there" } },
    { branch: "full text", text: "egret", elsewhere: { title: "Egret", host: "egret.example.com" } },
    { branch: "title trigrams", text: "ibisx", elsewhere: { title: "Ibis" } },
    { branch: "host trigrams", text: "storkk", elsewhere: { title: "Aaa", host: "stork.example.com" } },
    { branch: "short form", text: "ox", elsewhere: { title: "Ox cart", slug: "ox" } },
  ] as const)("take the candidates of the $branch branch from the active workspace alone (T2)", async ({ text, elsewhere }) => {
    const me = await account();
    const w = await workspace([me]);
    const elsewhereWorkspace = await workspace([me]);
    await bookmark(w, me, { title: "Zzz" });
    await bookmark(elsewhereWorkspace, me, elsewhere);

    expect(await found(w, me, text)).toEqual([]);
    expect(await found(elsewhereWorkspace, me, text)).toHaveLength(1);
  });

  it("answer an account that owns nothing in the workspace nothing, and the other member only their own", async () => {
    const me = await account();
    const other = await account();
    const stranger = await account();
    const w = await workspace([me, other]);
    const mine = await bookmark(w, me, { title: "Secret mine", slug: "secret" });
    const theirs = await bookmark(w, other, { title: "Secret theirs" });

    expect(await found(w, me, "secret")).toEqual([mine]);
    expect(await found(w, other, "secret")).toEqual([theirs]);
    expect(await found(w, stranger, "secret")).toEqual([]);
  });
});

describe("the matches of a text query and the search", () => {
  // The list matches what the search finds: the bookmarks the search ranks before its typo matches are exactly the matches of the list, and when it has no other the typo matches are. The search of
  // a library of fewer bookmarks than its limit answers every bookmark that matches.
  it("are the bookmarks the search ranks first, and its typo matches when it has no others", async () => {
    const me = await account();
    const other = await account();
    const w = await workspace([me, other]);
    await bookmark(w, me, { title: "Kubernetes handbook", slug: "k8s", host: "books.example.com" });
    await bookmark(w, me, { title: "Learning Git the hard way", host: "books.example.com", description: "git from the ground up" });
    await bookmark(w, me, { title: "Gti cheatsheet", slug: "git-cheats" });
    await bookmark(w, me, { title: "Docs", host: "stackoverflow.com", description: "kubernetes questions" });
    await bookmark(w, me, { title: "React patterns", slug: "react" });
    await bookmark(w, me, { title: "Read the docs", host: "readthedocs.io" });
    await bookmark(w, me, { title: "Percent 100% done", slug: "pct" });
    await bookmark(w, me, { title: "Notes & drafts (v2)", slug: "notes-v2" });
    await bookmark(w, other, { title: "Git for the other member", slug: "git" });
    await bookmark(w, me, { title: "Archived git", slug: "git-old", archived: true });

    const texts = ["git", "gi", "g", "kube", "kubernetes", "kubenetes", "k8s", "stackoverflw", "reac", "react", "rea", "read the docs", "docs", "books", "ground up", "100%", "notes & drafts", "v2", "&", "zzzq", "git cheats", "git-cheats"];
    for (const text of texts) {
      const matched = await found(w, me, text);
      const ranked = (await asSystemSearch(w, me, text)).map((hit) => hit.id);
      // Every match is among the first of the search's answer, the typo matches after them; with the fewer matches of the list the answer begins with exactly them.
      expect(ranked.slice(0, matched.length).toSorted(), text).toEqual(matched);
    }
  });
});

async function asSystemSearch(workspaceId: string, accountId: string, text: string): Promise<readonly { id: string }[]> {
  return db.tenant.withTenant({ accountId, workspaceId, requestId: "bookmark-match-test" }, (tx) => searchRepository(tx).bookmarks({ text, limit: 20 }));
}

describe("the matches of a text query for the bookmarks shared with the caller (T2, T12)", () => {
  describe.each([
    { form: "short", text: "zb", slug: "zb", title: "Zb planner" },
    { form: "long", text: "zebra", slug: "zebra", title: "Zebra planner" },
  ])("in the $form form", ({ text, slug, title }) => {
    it("returns the caller's own and the bookmarks shared directly, through a team and through a folder, and no other", async () => {
      const me = await account();
      const owner = await account();
      const teammate = await account();
      const w = await workspace([me, owner, teammate]);
      const team = await seedTeam(db, w, [owner, me]);
      const otherTeam = await seedTeam(db, w, [owner, teammate]);
      const mine = await bookmark(w, me, { title: `${title} mine`, slug });
      const direct = await bookmark(w, owner, { title: `${title} direct`, slug: `${slug}-direct` });
      const viaTeam = await bookmark(w, owner, { title: `${title} team`, slug: `${slug}-team` });
      const viaFolder = await bookmark(w, owner, { title: `${title} folder`, slug: `${slug}-folder` });
      const viaTeamFolder = await bookmark(w, owner, { title: `${title} team folder`, slug: `${slug}-team-folder` });
      await bookmark(w, owner, { title: `${title} private`, slug: `${slug}-private` });
      const toAnother = await bookmark(w, owner, { title: `${title} to another member`, slug: `${slug}-to-another-member` });
      const toOtherTeam = await bookmark(w, owner, { title: `${title} to another team`, slug: `${slug}-to-another-team` });
      const archived = await bookmark(w, owner, { title: `${title} archived`, slug: `${slug}-archived`, archived: true });
      await shareBookmark(db, w, direct, owner, { accountId: me });
      await shareBookmark(db, w, viaTeam, owner, { teamId: team });
      await shareThroughFolder(db, w, viaFolder, owner, { accountId: me });
      await shareThroughFolder(db, w, viaTeamFolder, owner, { teamId: team });
      await shareBookmark(db, w, toAnother, owner, { accountId: teammate });
      await shareBookmark(db, w, toOtherTeam, owner, { teamId: otherTeam });
      await shareBookmark(db, w, archived, owner, { accountId: me });

      expect(await found(w, me, text)).toEqual([mine, direct, viaTeam, viaFolder, viaTeamFolder].toSorted());
    });
  });

  it("returns a bookmark shared in another workspace in that workspace alone", async () => {
    const me = await account();
    const owner = await account();
    const here = await workspace([me, owner]);
    const there = await workspace([me, owner]);
    const elsewhere = await bookmark(there, owner, { title: "Okapi planner", slug: "okapi" });
    await shareBookmark(db, there, elsewhere, owner, { accountId: me });

    expect(await found(here, me, "okapi")).toEqual([]);
    expect(await found(there, me, "okapi")).toEqual([elsewhere]);
  });

  it("matches a shared bookmark by a typo only when nothing else matches, as the search does", async () => {
    const me = await account();
    const owner = await account();
    const w = await workspace([me, owner]);
    const shared = await bookmark(w, owner, { title: "Ptarmigan", host: "example.com" });
    await shareBookmark(db, w, shared, owner, { accountId: me });

    expect(await found(w, me, "ptarmigam")).toEqual([shared]);
    const own = await bookmark(w, me, { title: "Ptarmigam" });
    expect(await found(w, me, "ptarmigam")).toEqual([own]);
  });
});
