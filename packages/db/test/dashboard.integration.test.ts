import { dashboard } from "@slugbase/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountProfileRepository, dashboardRepository, tagRepository, TenantContextError } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// The reads of the dashboard (doc 02 section 9.3, doc 04 section 10.8, doc 05 section 2.4, doc 10 T1 and T2). The failure scenario: another member's pinned bookmark, quick-access slug or tag is
// never in a member's dashboard, and its counts never include another member's rows, a plan-archived bookmark or another workspace.

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
  await seedAccount(db, { id, email: `dashboard${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub", emailVerified: true });
  return id;
}

async function workspace(members: readonly string[]): Promise<string> {
  const id = await seedWorkspace(db, { name: "Dashboard test" });
  for (const accountId of members) {
    await seedMember(db, { workspaceId: id, accountId, role: "member" });
  }
  return id;
}

interface Seed {
  readonly title: string;
  readonly slug?: string | null;
  readonly forwarding?: boolean;
  readonly pinnedAt?: Date | null;
  readonly archived?: boolean;
  readonly openCount?: number;
}

async function bookmark(workspaceId: string, ownerId: string | null, seed: Seed): Promise<string> {
  const id = freshId();
  await asSystem(
    db,
    (tx) => tx`
      INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, slug, forwarding, pinned_at, plan_archived_at, open_count)
      VALUES (${id}, ${workspaceId}, ${ownerId}, ${`https://example.com/${id}`}, ${`https://example.com/${id}`}, 'example.com', ${seed.title}, ${seed.slug ?? null},
              ${seed.forwarding ?? false}, ${seed.pinnedAt ?? null}, ${seed.archived === true ? new Date() : null}, ${seed.openCount ?? 0})`,
  );
  return id;
}

async function folder(workspaceId: string, ownerId: string, name: string): Promise<string> {
  const id = freshId();
  await asSystem(db, (tx) => tx`INSERT INTO folders (id, workspace_id, owner_id, name) VALUES (${id}, ${workspaceId}, ${ownerId}, ${name})`);
  return id;
}

async function tag(workspaceId: string, ownerId: string, name: string, on: readonly string[] = []): Promise<string> {
  const id = freshId();
  await asSystem(db, async (tx) => {
    await tx`INSERT INTO tags (id, workspace_id, owner_id, name) VALUES (${id}, ${workspaceId}, ${ownerId}, ${name})`;
    for (const bookmarkId of on) {
      await tx`INSERT INTO bookmark_tags (workspace_id, bookmark_id, tag_id) VALUES (${workspaceId}, ${bookmarkId}, ${id})`;
    }
  });
  return id;
}

function asMember<T>(workspaceId: string, accountId: string, work: Parameters<typeof db.tenant.withTenant<T>>[1]): Promise<T> {
  return db.tenant.withTenant({ accountId, workspaceId, requestId: "dashboard-test" }, work);
}

function dashboardOf(workspaceId: string, accountId: string) {
  return asMember(workspaceId, accountId, (tx) => dashboard({ store: dashboardRepository(tx), tags: tagRepository(tx) }, { accountId, sharing: false }));
}

const minutesAgo = (minutes: number): Date => new Date(Date.now() - minutes * 60_000);

describe("the quick access", () => {
  it("lists the caller's forwarding bookmarks by their slug, the most opened first, up to eight", async () => {
    const me = await account();
    const w = await workspace([me]);
    const ids: string[] = [];
    for (let n = 0; n < 10; n += 1) {
      ids.push(await bookmark(w, me, { title: `Slug ${String(n)}`, slug: `slug-${String(n)}`, forwarding: true, openCount: n }));
    }
    const tied = await bookmark(w, me, { title: "Tied", slug: "tied", forwarding: true, openCount: 9 });
    await bookmark(w, me, { title: "No forwarding", slug: "off", forwarding: false, openCount: 100 });
    await bookmark(w, me, { title: "No slug", openCount: 100 });

    const listed = await asMember(w, me, (tx) => dashboardRepository(tx).quickAccess(me, 8));

    // The most opened first and, among equals, the greater identifier: the tied pair, then 8 to 3 opens.
    const tiedPair = [tied, ids[9]].sort().reverse();
    expect(listed.map((entry) => entry.id)).toEqual([...tiedPair, ...ids.slice(3, 9).reverse()]);
    expect(listed).toHaveLength(8);
    expect(listed[2]).toEqual({ id: ids[8], title: "Slug 8", url: expect.stringContaining("https://example.com/") as string, host: "example.com", slug: "slug-8", forwarding: true, openCount: 8 });
  });

  it("never lists a plan-archived bookmark, another member's bookmark or one of another workspace", async () => {
    const me = await account();
    const other = await account();
    const w = await workspace([me, other]);
    const elsewhere = await workspace([me, other]);
    const mine = await bookmark(w, me, { title: "Mine", slug: "mine", forwarding: true, openCount: 1 });
    await bookmark(w, me, { title: "Archived", slug: "archived", forwarding: true, openCount: 50, archived: true });
    await bookmark(w, other, { title: "Theirs", slug: "theirs", forwarding: true, openCount: 99 });
    await bookmark(w, null, { title: "Ownerless", slug: "ownerless", forwarding: true, openCount: 99 });
    await bookmark(elsewhere, me, { title: "Elsewhere", slug: "elsewhere", forwarding: true, openCount: 99 });

    expect((await asMember(w, me, (tx) => dashboardRepository(tx).quickAccess(me, 8))).map((entry) => entry.id)).toEqual([mine]);
  });
});

describe("the pinned bookmarks", () => {
  it("are the caller's own, the most recently pinned first, up to the limit, and not plan-archived", async () => {
    const me = await account();
    const other = await account();
    const w = await workspace([me, other]);
    const pinned: string[] = [];
    for (let n = 0; n < 14; n += 1) {
      pinned.push(await bookmark(w, me, { title: `Pinned ${String(n)}`, pinnedAt: minutesAgo(100 - n) }));
    }
    await bookmark(w, me, { title: "Archived pin", pinnedAt: minutesAgo(1), archived: true });
    await bookmark(w, me, { title: "Not pinned" });
    await bookmark(w, other, { title: "Their pin", pinnedAt: minutesAgo(0.5) });

    const listed = await asMember(w, me, (tx) => dashboardRepository(tx).pinned(me, 12));

    expect(listed.map((entry) => entry.id)).toEqual(pinned.slice(2).reverse());
    expect(listed[0]).toMatchObject({ title: "Pinned 13", slug: null, forwarding: false, openCount: 0 });
  });

  it("breaks a tie of the pin time by the identifier, the greater first", async () => {
    const me = await account();
    const w = await workspace([me]);
    const at = minutesAgo(5);
    const ids = [await bookmark(w, me, { title: "A", pinnedAt: at }), await bookmark(w, me, { title: "B", pinnedAt: at }), await bookmark(w, me, { title: "C", pinnedAt: at })];

    expect((await asMember(w, me, (tx) => dashboardRepository(tx).pinned(me, 12))).map((entry) => entry.id)).toEqual(ids.toSorted().reverse());
  });
});

describe("the summary", () => {
  it("counts the caller's own bookmarks that are not plan-archived, folders and tags, and no other member's, and nothing of another workspace", async () => {
    const me = await account();
    const other = await account();
    const w = await workspace([me, other]);
    const elsewhere = await workspace([me, other]);
    await bookmark(w, me, { title: "One" });
    await bookmark(w, me, { title: "Two", slug: "two", forwarding: true });
    await bookmark(w, me, { title: "Archived", archived: true });
    await bookmark(w, other, { title: "Theirs" });
    await bookmark(w, null, { title: "Ownerless" });
    await bookmark(elsewhere, me, { title: "Elsewhere" });
    await folder(w, me, "Mine");
    await folder(w, other, "Theirs");
    await folder(elsewhere, me, "Elsewhere");
    await tag(w, me, "mine-1");
    await tag(w, me, "mine-2");
    await tag(w, other, "theirs");
    await tag(elsewhere, me, "elsewhere");

    expect(await asMember(w, me, (tx) => dashboardRepository(tx).summary(me))).toEqual({ bookmarks: 2, folders: 1, tags: 2, hasBookmark: true, hasSlug: true });
    expect(await asMember(w, other, (tx) => dashboardRepository(tx).summary(other))).toEqual({ bookmarks: 1, folders: 1, tags: 1, hasBookmark: true, hasSlug: false });
    expect(await asMember(elsewhere, me, (tx) => dashboardRepository(tx).summary(me))).toEqual({ bookmarks: 1, folders: 1, tags: 1, hasBookmark: true, hasSlug: false });
  });

  it("says a member who only has plan-archived bookmarks added one and gave one a slug, with none counted", async () => {
    const me = await account();
    const w = await workspace([me]);
    await bookmark(w, me, { title: "Archived", slug: "archived", archived: true });

    expect(await asMember(w, me, (tx) => dashboardRepository(tx).summary(me))).toEqual({ bookmarks: 0, folders: 0, tags: 0, hasBookmark: true, hasSlug: true });
  });

  it("is empty for a member with nothing", async () => {
    const me = await account();
    const w = await workspace([me]);

    expect(await asMember(w, me, (tx) => dashboardRepository(tx).summary(me))).toEqual({ bookmarks: 0, folders: 0, tags: 0, hasBookmark: false, hasSlug: false });
  });
});

describe("the dashboard", () => {
  it("shows the caller's most used tags with their counts, the plan-archived bookmarks not counted, and never another member's tag", async () => {
    const me = await account();
    const other = await account();
    const w = await workspace([me, other]);
    const a = await bookmark(w, me, { title: "A" });
    const b = await bookmark(w, me, { title: "B" });
    const archived = await bookmark(w, me, { title: "Archived", archived: true });
    const theirs = await bookmark(w, other, { title: "Theirs" });
    const busy = await tag(w, me, "busy", [a, b, archived]);
    const quiet = await tag(w, me, "quiet", [a]);
    const empty = await tag(w, me, "empty");
    await tag(w, other, "their-tag", [theirs]);

    const answer = await dashboardOf(w, me);

    expect(answer?.topTags).toEqual([
      { id: busy, name: "busy", bookmarkCount: 2 },
      { id: quiet, name: "quiet", bookmarkCount: 1 },
      { id: empty, name: "empty", bookmarkCount: 0 },
    ]);
    expect(JSON.stringify(answer)).not.toContain("their-tag");
  });

  it("holds twelve tags at most", async () => {
    const me = await account();
    const w = await workspace([me]);
    for (let n = 0; n < 14; n += 1) {
      await tag(w, me, `tag-${String(n).padStart(2, "0")}`);
    }

    expect((await dashboardOf(w, me))?.topTags).toHaveLength(12);
  });

  it("never shows another member's pinned bookmark, quick access or tag, or the counts of another workspace (T1, T2)", async () => {
    const me = await account();
    const other = await account();
    const stranger = await account();
    const w = await workspace([me, other]);
    const strangers = await workspace([stranger]);
    await bookmark(w, me, { title: "Mine", slug: "mine", forwarding: true, pinnedAt: minutesAgo(2), openCount: 1 });
    const theirs = await bookmark(w, other, { title: "Their secret", slug: "their-secret", forwarding: true, pinnedAt: minutesAgo(1), openCount: 99 });
    await tag(w, other, "their-secret-tag", [theirs]);
    await folder(w, other, "Their secret folder");
    const secret = await bookmark(strangers, stranger, { title: "Stranger secret", slug: "stranger-secret", forwarding: true, pinnedAt: minutesAgo(1), openCount: 99 });
    await tag(strangers, stranger, "stranger-secret-tag", [secret]);
    await folder(strangers, stranger, "Stranger secret folder");

    const answer = await dashboardOf(w, me);

    expect(answer?.counts).toEqual({ bookmarks: 1, folders: 0, tags: 0, sharedWithYou: null });
    expect(answer?.quickAccess.map((entry) => entry.title)).toEqual(["Mine"]);
    expect(answer?.pinned.map((entry) => entry.title)).toEqual(["Mine"]);
    expect(answer?.topTags).toEqual([]);
    expect(JSON.stringify(answer)).not.toMatch(/secret/i);
    expect(answer?.onboarding).toEqual({ bookmarkAdded: true, slugGiven: true, browserSetupDone: false, folderCreated: false, importDone: false, dismissed: false });
  });

  it("reads the stored checklist state of the account, which PATCH /me writes", async () => {
    const me = await account();
    const w = await workspace([me]);
    await asMember(w, me, (tx) => accountProfileRepository(tx).updateProfile({ onboarding: { browserSetupDone: true, checklistDismissed: true } }));

    expect((await dashboardOf(w, me))?.onboarding).toEqual({ bookmarkAdded: false, slugGiven: false, browserSetupDone: true, folderCreated: false, importDone: false, dismissed: true });
  });
});

describe("the repository", () => {
  it("is read for the account of the transaction only, and needs a workspace", async () => {
    const me = await account();
    const other = await account();
    const w = await workspace([me, other]);

    await expect(asMember(w, me, (tx) => dashboardRepository(tx).summary(other))).rejects.toThrow("the account of the transaction only");
    await expect(asMember(w, me, (tx) => dashboardRepository(tx).quickAccess(other, 8))).rejects.toThrow("the account of the transaction only");
    await expect(asMember(w, me, (tx) => dashboardRepository(tx).pinned(other, 12))).rejects.toThrow("the account of the transaction only");
    await expect(asMember(w, me, (tx) => dashboardRepository(tx).onboarding(other))).rejects.toThrow("the account of the transaction only");
    await expect(asMember(w, me, (tx) => dashboardRepository(tx).quickAccess(me, 0))).rejects.toThrow("positive whole limit");
    await expect(db.tenant.withTenant({ accountId: me, requestId: "dashboard-test" }, (tx) => dashboardRepository(tx).summary(me))).rejects.toBeInstanceOf(TenantContextError);
    await expect(db.tenant.withTenant({ accountId: me, requestId: "dashboard-test" }, (tx) => dashboardRepository(tx).quickAccess(me, 8))).rejects.toBeInstanceOf(TenantContextError);
    await expect(db.tenant.withTenant({ accountId: me, requestId: "dashboard-test" }, (tx) => dashboardRepository(tx).pinned(me, 12))).rejects.toBeInstanceOf(TenantContextError);
  });

  it("reads an account that stored nothing as every box unticked", async () => {
    const me = await account();
    const w = await workspace([me]);

    expect(await asMember(w, me, (tx) => dashboardRepository(tx).onboarding(me))).toEqual({ browserSetupDone: false, importDone: false, checklistDismissed: false });
  });
});
