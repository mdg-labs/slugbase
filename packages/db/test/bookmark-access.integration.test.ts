import type { BookmarkScope } from "@slugbase/core";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bookmarkRepository } from "../src/index.ts";
import { bookmarkReadableBy } from "../src/repositories/bookmark-access.ts";
import { tenantHandle } from "../src/tenant.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// The access predicate of doc 05 section 4 (`bookmarkReadableBy`, doc 02 section 8.2, doc 10 T1 and T2): a bookmark is readable by its owner and by the members it is shared with,
// directly, through a team or through a folder it is filed in, and by nobody else. The failure scenario: a member the bookmark is shared with writes it (changes, pins, files, tags or deletes
// it) through the repository, or reads the owner's folders and tags of it, and a member it is not shared with, a share of another workspace and a plan-archived bookmark each read it. Every
// answer of the lookup, of the list and of the counts is held to the predicate, so a change to the rules of reading is one change.

const HOOK_TIMEOUT_MS = 300_000;

let db: TestDatabase;
let workspaceId: string;
let other: string;
const accounts: Record<"owner" | "direct" | "teammate" | "viaFolder" | "viaTeamFolder" | "twice" | "outsider", string> = {
  owner: "",
  direct: "",
  teammate: "",
  viaFolder: "",
  viaTeamFolder: "",
  twice: "",
  outsider: "",
};
const bookmarks: Record<"private" | "direct" | "team" | "folder" | "teamFolder" | "twice" | "archived" | "ownerless" | "otherWorkspace" | "filedUnshared", string> = {
  private: "",
  direct: "",
  team: "",
  folder: "",
  teamFolder: "",
  twice: "",
  archived: "",
  ownerless: "",
  otherWorkspace: "",
  filedUnshared: "",
};
let ownersFolder: string;
let ownersTag: string;

function inTenant<T>(accountId: string, work: Parameters<typeof db.tenant.withTenant<T>>[1], workspace = workspaceId): Promise<T> {
  return db.tenant.withTenant({ accountId, workspaceId: workspace, requestId: "bookmark-access-test" }, work);
}

async function insertBookmark(workspace: string, ownerId: string | null, title: string, extra: { archived?: boolean } = {}): Promise<string> {
  const id = freshId();
  await asSystem(
    db,
    (tx) => tx`
      INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, plan_archived_at)
      VALUES (${id}, ${workspace}, ${ownerId}, ${"https://example.com/" + title}, ${"https://example.com/" + title}, 'example.com', ${title}, ${extra.archived === true ? new Date() : null})`,
  );
  return id;
}

beforeAll(async () => {
  db = await createTestDatabase();
  workspaceId = await seedWorkspace(db, { name: "Access test" });
  const otherWorkspace = await seedWorkspace(db, { name: "Access test, another workspace" });
  for (const [index, name] of (Object.keys(accounts) as (keyof typeof accounts)[]).entries()) {
    accounts[name] = freshId();
    await seedAccount(db, { id: accounts[name], email: `access${String(index)}@example.test`, passwordHash: "$argon2id$stub", displayName: `Member ${name}` });
    await seedMember(db, { workspaceId, accountId: accounts[name], role: name === "owner" ? "owner" : "member" });
    await seedMember(db, { workspaceId: otherWorkspace, accountId: accounts[name], role: name === "owner" ? "owner" : "member" });
  }
  other = otherWorkspace;
  for (const [name, title] of [["private", "Private"], ["direct", "Direct"], ["team", "Team"], ["folder", "Folder"], ["teamFolder", "TeamFolder"], ["twice", "Twice"], ["filedUnshared", "FiledUnshared"]] as const) {
    bookmarks[name] = await insertBookmark(workspaceId, accounts.owner, title);
  }
  bookmarks.archived = await insertBookmark(workspaceId, accounts.owner, "Archived", { archived: true });
  bookmarks.ownerless = await insertBookmark(workspaceId, null, "Ownerless");
  bookmarks.otherWorkspace = await insertBookmark(other, accounts.owner, "OtherWorkspace");
  const team = freshId();
  const teamOfFolders = freshId();
  const folderOfTeam = freshId();
  const unsharedFolder = freshId();
  ownersFolder = freshId();
  ownersTag = freshId();
  await asSystem(db, async (tx) => {
    await tx`INSERT INTO teams (id, workspace_id, name) VALUES (${team}, ${workspaceId}, 'Readers'), (${teamOfFolders}, ${workspaceId}, 'Folder readers')`;
    await tx`INSERT INTO team_members (workspace_id, team_id, account_id) VALUES (${workspaceId}, ${team}, ${accounts.teammate}), (${workspaceId}, ${team}, ${accounts.twice}), (${workspaceId}, ${teamOfFolders}, ${accounts.viaTeamFolder})`;
    await tx`INSERT INTO folders (id, workspace_id, owner_id, name) VALUES (${ownersFolder}, ${workspaceId}, ${accounts.owner}, 'Owner folder'), (${folderOfTeam}, ${workspaceId}, ${accounts.owner}, 'Team folder'), (${unsharedFolder}, ${workspaceId}, ${accounts.owner}, 'Unshared folder')`;
    await tx`INSERT INTO tags (id, workspace_id, owner_id, name) VALUES (${ownersTag}, ${workspaceId}, ${accounts.owner}, 'owners-tag')`;
    await tx`INSERT INTO bookmark_tags (workspace_id, bookmark_id, tag_id) VALUES (${workspaceId}, ${bookmarks.direct}, ${ownersTag})`;
    await tx`
      INSERT INTO folder_bookmarks (workspace_id, folder_id, bookmark_id) VALUES
        (${workspaceId}, ${ownersFolder}, ${bookmarks.folder}), (${workspaceId}, ${ownersFolder}, ${bookmarks.direct}), (${workspaceId}, ${folderOfTeam}, ${bookmarks.teamFolder}),
        (${workspaceId}, ${unsharedFolder}, ${bookmarks.filedUnshared})`;
    await tx`
      INSERT INTO bookmark_shares (id, workspace_id, bookmark_id, target_account_id, target_team_id, granted_by) VALUES
        (${freshId()}, ${workspaceId}, ${bookmarks.direct}, ${accounts.direct}, NULL, ${accounts.owner}),
        (${freshId()}, ${workspaceId}, ${bookmarks.team}, NULL, ${team}, ${accounts.owner}),
        (${freshId()}, ${workspaceId}, ${bookmarks.twice}, ${accounts.twice}, NULL, ${accounts.owner}),
        (${freshId()}, ${workspaceId}, ${bookmarks.twice}, NULL, ${team}, ${accounts.owner}),
        (${freshId()}, ${workspaceId}, ${bookmarks.archived}, ${accounts.direct}, NULL, ${accounts.owner}),
        (${freshId()}, ${workspaceId}, ${bookmarks.ownerless}, ${accounts.direct}, NULL, NULL)`;
    await tx`
      INSERT INTO folder_shares (id, workspace_id, folder_id, target_account_id, target_team_id, granted_by) VALUES
        (${freshId()}, ${workspaceId}, ${ownersFolder}, ${accounts.viaFolder}, NULL, ${accounts.owner}),
        (${freshId()}, ${workspaceId}, ${ownersFolder}, ${accounts.twice}, NULL, ${accounts.owner}),
        (${freshId()}, ${workspaceId}, ${folderOfTeam}, NULL, ${teamOfFolders}, ${accounts.owner})`;
    // A share of the other workspace, naming the same members: it gives nothing in this one.
    await tx`INSERT INTO bookmark_shares (id, workspace_id, bookmark_id, target_account_id, granted_by) VALUES (${freshId()}, ${other}, ${bookmarks.otherWorkspace}, ${accounts.outsider}, ${accounts.owner})`;
  });
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await db.drop();
}, HOOK_TIMEOUT_MS);

/** Who can read what, as the rules of doc 02 section 8.2 say, with the plan-archived and the other workspace's bookmarks never readable. */
const READABLE: Readonly<Record<keyof typeof accounts, readonly (keyof typeof bookmarks)[]>> = {
  owner: ["private", "direct", "team", "folder", "teamFolder", "twice", "filedUnshared"],
  direct: ["direct", "ownerless"],
  teammate: ["team", "twice"],
  viaFolder: ["folder", "direct"],
  viaTeamFolder: ["teamFolder"],
  twice: ["team", "twice", "folder", "direct"],
  outsider: [],
};

const idsOf = (names: readonly (keyof typeof bookmarks)[]): string[] => names.map((name) => bookmarks[name]).toSorted();

describe("the access predicate", () => {
  it.each(Object.entries(READABLE))("holds for the bookmarks %s can read and for no other of the workspace", async (name, readable) => {
    const accountId = accounts[name as keyof typeof accounts];

    const found = await inTenant(accountId, async (tx) => {
      const rows = await tenantHandle(tx).execute<{ id: string }>(sql`SELECT id FROM bookmarks WHERE workspace_id = ${workspaceId}::uuid AND plan_archived_at IS NULL AND ${bookmarkReadableBy(accountId)}`);
      return rows.map((row) => row.id).toSorted();
    });

    expect(found).toEqual(idsOf(readable));
  });

  it("is the one rule the lists, the lookup and the counts use: they agree with it for every member and every scope", async () => {
    for (const [name, accountId] of Object.entries(accounts)) {
      const readable = idsOf(READABLE[name as keyof typeof accounts]);
      const own = await inTenant(accountId, (tx) => bookmarkRepository(tx).ids({ ownerId: accountId, scope: "mine" }, 100));
      const shared = await inTenant(accountId, (tx) => bookmarkRepository(tx).ids({ ownerId: accountId, scope: "shared_with_me" }, 100));
      const all = await inTenant(accountId, (tx) => bookmarkRepository(tx).ids({ ownerId: accountId, scope: "all" }, 100));
      const counts = await inTenant(accountId, async (tx) => {
        const counted: Record<BookmarkScope, number> = { all: 0, mine: 0, shared_with_me: 0, shared_by_me: 0 };
        for (const scope of Object.keys(counted) as BookmarkScope[]) {
          counted[scope] = await bookmarkRepository(tx).count({ ownerId: accountId, scope }, 100);
        }
        return counted;
      });
      const looked = await inTenant(accountId, async (tx) => {
        const found: string[] = [];
        for (const id of Object.values(bookmarks)) {
          if ((await bookmarkRepository(tx).find(id)) !== undefined) {
            found.push(id);
          }
        }
        return found.toSorted();
      });

      expect([name, all.toSorted()]).toEqual([name, readable]);
      expect([name, looked]).toEqual([name, readable]);
      expect([name, [...own, ...shared].toSorted()]).toEqual([name, readable]);
      expect([name, own.filter((id) => shared.includes(id))]).toEqual([name, []]);
      expect([name, counts.all, counts.mine, counts.shared_with_me]).toEqual([name, readable.length, own.length, shared.length]);
    }
  });

  it("lists, for the owner, the bookmarks shared with anyone: directly, through a team or through a folder", async () => {
    const found = await inTenant(accounts.owner, (tx) => bookmarkRepository(tx).ids({ ownerId: accounts.owner, scope: "shared_by_me" }, 100));

    expect(found.toSorted()).toEqual(idsOf(["direct", "team", "folder", "teamFolder", "twice"]));
  });

  it("reads a bookmark with its owner and how it is shared, the direct share before the team's before the folder's", async () => {
    const via = async (name: keyof typeof accounts, bookmark: keyof typeof bookmarks) => (await inTenant(accounts[name], (tx) => bookmarkRepository(tx).find(bookmarks[bookmark])))?.sharedVia;
    const ownerRecord = await inTenant(accounts.direct, (tx) => bookmarkRepository(tx).find(bookmarks.direct));

    expect(await via("direct", "direct")).toBe("direct");
    expect(await via("teammate", "team")).toBe("team");
    expect(await via("viaFolder", "folder")).toBe("folder");
    expect(await via("viaTeamFolder", "teamFolder")).toBe("folder");
    expect(await via("twice", "twice")).toBe("direct");
    expect(await via("twice", "folder")).toBe("folder");
    expect(await via("owner", "twice")).toBeNull();
    expect(ownerRecord?.owner).toEqual({ accountId: accounts.owner, displayName: "Member owner" });
    expect((await inTenant(accounts.direct, (tx) => bookmarkRepository(tx).find(bookmarks.ownerless)))).toMatchObject({ ownerId: null, owner: null, sharedVia: "direct" });
  });

  it("shows a recipient nothing of the owner's folders or tags of the bookmark, and not the owner's pin", async () => {
    await asSystem(db, (tx) => tx`UPDATE bookmarks SET pinned_at = now() WHERE id = ${bookmarks.direct}`);

    const seen = await inTenant(accounts.direct, (tx) => bookmarkRepository(tx).find(bookmarks.direct));
    const owners = await inTenant(accounts.owner, (tx) => bookmarkRepository(tx).find(bookmarks.direct));
    const listed = await inTenant(accounts.direct, (tx) => bookmarkRepository(tx).list({ filter: { ownerId: accounts.direct, scope: "all" }, sort: "recent", after: undefined, limit: 10 }));

    expect(seen).toMatchObject({ folders: [], tags: [], pinned: false });
    expect(owners).toMatchObject({ folders: [{ id: ownersFolder }], tags: [{ id: ownersTag }], pinned: true });
    expect(listed.map((row) => ({ id: row.bookmark.id, folders: row.bookmark.folders, tags: row.bookmark.tags, pinned: row.bookmark.pinned }))).toEqual(
      expect.arrayContaining([{ id: bookmarks.direct, folders: [], tags: [], pinned: false }]),
    );
  });
});

describe("the lists with a text query", () => {
  it("narrow the scope of the list by the matches of the search, which are the caller's own bookmarks, whichever filter comes with the text", async () => {
    const found = async (accountId: string, filter: { scope: BookmarkScope; q: string; pinned?: boolean }) =>
      (await inTenant(accountId, (tx) => bookmarkRepository(tx).list({ filter: { ownerId: accountId, ...filter }, sort: "recent", after: undefined, limit: 10 }))).map((row) => row.bookmark.id);
    const counted = async (accountId: string, filter: { scope: BookmarkScope; q: string; pinned?: boolean }) =>
      inTenant(accountId, (tx) => bookmarkRepository(tx).count({ ownerId: accountId, ...filter }, 10));

    expect(await found(accounts.owner, { scope: "all", q: "Private" })).toEqual([bookmarks.private]);
    expect(await found(accounts.owner, { scope: "all", q: "Private", pinned: false })).toEqual([bookmarks.private]);
    expect(await found(accounts.owner, { scope: "shared_by_me", q: "Twice" })).toEqual([bookmarks.twice]);
    expect(await found(accounts.owner, { scope: "shared_by_me", q: "Private" })).toEqual([]);
    expect(await found(accounts.owner, { scope: "shared_with_me", q: "Twice" })).toEqual([]);
    expect(await found(accounts.direct, { scope: "all", q: "Direct", pinned: false })).toEqual([]);
    expect(await counted(accounts.owner, { scope: "shared_by_me", q: "Twice" })).toBe(1);
    expect(await counted(accounts.owner, { scope: "all", q: "Private", pinned: false })).toBe(1);
    expect(await counted(accounts.owner, { scope: "shared_with_me", q: "Twice" })).toBe(0);
    await expect(inTenant(accounts.direct, (tx) => bookmarkRepository(tx).count({ ownerId: accounts.owner, scope: "shared_by_me", q: "Twice" }, 10))).rejects.toThrow();
  });
});

describe("what a member the bookmark is shared with may not do", () => {
  it("changes, pins, files, tags and deletes nothing of it through the repository, and the bookmark is as it was", async () => {
    const recipient = accounts.direct;
    const target = bookmarks.direct;
    const [recipientsFolder, recipientsTag] = [freshId(), freshId()];
    await asSystem(db, async (tx) => {
      await tx`INSERT INTO folders (id, workspace_id, owner_id, name) VALUES (${recipientsFolder}, ${workspaceId}, ${recipient}, 'Recipient folder')`;
      await tx`INSERT INTO tags (id, workspace_id, owner_id, name) VALUES (${recipientsTag}, ${workspaceId}, ${recipient}, 'recipient-tag')`;
    });
    const state = async () => ({
      bookmark: await asSystem(db, (tx) => tx<{ row: string }[]>`SELECT b::text AS row FROM bookmarks b WHERE id = ${target}`),
      folders: await asSystem(db, (tx) => tx<{ folder_id: string }[]>`SELECT folder_id FROM folder_bookmarks WHERE bookmark_id = ${target} ORDER BY folder_id`),
      tags: await asSystem(db, (tx) => tx<{ tag_id: string }[]>`SELECT tag_id FROM bookmark_tags WHERE bookmark_id = ${target} ORDER BY tag_id`),
    });
    const before = await state();

    const outcome = await inTenant(recipient, async (tx) => {
      const repository = bookmarkRepository(tx);
      return {
        update: await repository.update({ bookmarkId: target, ownerId: recipient, changes: { title: "Taken over", pinned: true, folderIds: [recipientsFolder], tags: { ids: [recipientsTag], names: [] } }, expectedVersions: undefined }),
        remove: await repository.remove({ bookmarkId: target, ownerId: recipient }),
        removed: await repository.removeMany({ bookmarkIds: [target] }),
        pinned: await repository.setPinned({ bookmarkIds: [target], ownerId: recipient, pinned: true }),
        filed: await repository.fileIn({ bookmarkIds: [target], ownerId: recipient, folderId: recipientsFolder, mode: "add" }),
        tagged: await repository.tag({ bookmarkIds: [target], ownerId: recipient, tagIds: [recipientsTag], mode: "add" }),
        previewed: await repository.previewTags({ bookmarkIds: [target], ownerId: recipient, tagIds: [recipientsTag] }),
      };
    });

    expect(outcome.update).toEqual({ kind: "not_found" });
    expect(outcome.remove).toBe(false);
    expect(outcome.removed).toBe(0);
    expect(outcome.pinned).toBe(0);
    expect(outcome.filed).toEqual({ kind: "done", affected: 0 });
    expect(outcome.tagged).toEqual({ kind: "done", affected: 0 });
    expect(outcome.previewed).toMatchObject({ kind: "previewed", affected: 0 });
    expect(await state()).toEqual(before);
  });

  it("is told by the repository that the bookmark is shared with it, and no member it is not shared with is", async () => {
    const asked = async (name: keyof typeof accounts, bookmark: keyof typeof bookmarks) =>
      inTenant(accounts[name], (tx) => bookmarkRepository(tx).sharedWith({ bookmarkId: bookmarks[bookmark], accountId: accounts[name] }));
    const among = async (name: keyof typeof accounts) =>
      inTenant(accounts[name], (tx) => bookmarkRepository(tx).sharedAmong({ bookmarkIds: Object.values(bookmarks), accountId: accounts[name] }));

    expect([await asked("direct", "direct"), await asked("teammate", "team"), await asked("viaFolder", "folder"), await asked("viaTeamFolder", "teamFolder")]).toEqual([true, true, true, true]);
    expect([await asked("owner", "direct"), await asked("outsider", "direct"), await asked("direct", "private"), await asked("direct", "archived")]).toEqual([false, false, false, false]);
    expect((await among("direct")).toSorted()).toEqual(idsOf(["direct", "ownerless"]));
    expect(await among("owner")).toEqual([]);
    expect(await among("outsider")).toEqual([]);
  });

  it("is refused a repository call made for another account than the transaction's", async () => {
    await expect(inTenant(accounts.direct, (tx) => bookmarkRepository(tx).sharedWith({ bookmarkId: bookmarks.direct, accountId: accounts.owner }))).rejects.toThrow();
    await expect(inTenant(accounts.direct, (tx) => bookmarkRepository(tx).list({ filter: { ownerId: accounts.owner, scope: "shared_with_me" }, sort: "recent", after: undefined, limit: 10 }))).rejects.toThrow();
  });
});

describe("a share of one workspace in the list of another", () => {
  it("gives nothing in the other workspace: the outsider reads the bookmark of the other workspace only there, through the share that is there", async () => {
    const there = await inTenant(accounts.outsider, (tx) => bookmarkRepository(tx).ids({ ownerId: accounts.outsider, scope: "shared_with_me" }, 10), other);
    const here = await inTenant(accounts.outsider, (tx) => bookmarkRepository(tx).ids({ ownerId: accounts.outsider, scope: "all" }, 10));
    const hereByIdentifier = await inTenant(accounts.outsider, (tx) => bookmarkRepository(tx).find(bookmarks.otherWorkspace));

    expect(there).toEqual([bookmarks.otherWorkspace]);
    expect(here).toEqual([]);
    expect(hereByIdentifier).toBeUndefined();
  });
});
