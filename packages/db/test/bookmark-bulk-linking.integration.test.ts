import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bookmarkRepository, type TenantTx } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// Filing and tagging many bookmarks at once (doc 02 section 5.8, doc 05 section 2.4, doc 10 T1 and T2). The failure scenario: a member who tags
// ids that include another member's bookmarks, and one of another workspace, tags their own and leaves the rest untouched; and the ones around it: a
// folder or a tag that is another member's ends the call with nothing written, a move that leaves a link to a folder it was meant to replace, a plan-archived
// bookmark that is filed or tagged, a version that moves with a link, a preview that writes, and two calls over the same bookmarks that deadlock.

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
  await seedAccount(db, { id, email: `linking${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub" });
  return id;
}

interface Workspace {
  readonly id: string;
  readonly a: string;
  readonly b: string;
}

async function workspaceOf(): Promise<Workspace> {
  const id = await seedWorkspace(db, { name: "Linking test" });
  const [a, b] = [await account(), await account()];
  await seedMember(db, { workspaceId: id, accountId: a, role: "owner" });
  await seedMember(db, { workspaceId: id, accountId: b, role: "member" });
  return { id, a, b };
}

function inTenant<T>(tenant: { accountId: string; workspaceId: string }, work: (tx: TenantTx) => Promise<T>): Promise<T> {
  return db.tenant.withTenant({ ...tenant, requestId: "linking-test" }, work);
}

async function seedFolder(workspaceId: string, ownerId: string, name: string): Promise<string> {
  const id = freshId();
  await asSystem(db, (tx) => tx`INSERT INTO folders (id, workspace_id, owner_id, name) VALUES (${id}, ${workspaceId}, ${ownerId}, ${name})`);
  return id;
}

async function seedTag(workspaceId: string, ownerId: string, name: string): Promise<string> {
  const id = freshId();
  await asSystem(db, (tx) => tx`INSERT INTO tags (id, workspace_id, owner_id, name) VALUES (${id}, ${workspaceId}, ${ownerId}, ${name})`);
  return id;
}

async function seedBookmark(workspaceId: string, ownerId: string, archived = false): Promise<string> {
  const id = freshId();
  await asSystem(
    db,
    (tx) => tx`
      INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, plan_archived_at)
      VALUES (${id}, ${workspaceId}, ${ownerId}, 'https://example.com/seed', 'https://example.com/seed', 'example.com', 'Seed', ${archived ? new Date() : null})`,
  );
  return id;
}

async function file(workspaceId: string, folderId: string, bookmarkId: string): Promise<void> {
  await asSystem(db, (tx) => tx`INSERT INTO folder_bookmarks (workspace_id, folder_id, bookmark_id) VALUES (${workspaceId}, ${folderId}, ${bookmarkId})`);
}

async function tagLink(workspaceId: string, bookmarkId: string, tagId: string): Promise<void> {
  await asSystem(db, (tx) => tx`INSERT INTO bookmark_tags (workspace_id, bookmark_id, tag_id) VALUES (${workspaceId}, ${bookmarkId}, ${tagId})`);
}

async function folderLinks(workspaceId: string): Promise<string[]> {
  const rows = await asSystem(db, (tx) => tx<{ link: string }[]>`SELECT bookmark_id || '/' || folder_id AS link FROM folder_bookmarks WHERE workspace_id = ${workspaceId} ORDER BY 1`);
  return rows.map((row) => row.link);
}

async function tagLinks(workspaceId: string): Promise<string[]> {
  const rows = await asSystem(db, (tx) => tx<{ link: string }[]>`SELECT bookmark_id || '/' || tag_id AS link FROM bookmark_tags WHERE workspace_id = ${workspaceId} ORDER BY 1`);
  return rows.map((row) => row.link);
}

async function versionsOf(workspaceId: string): Promise<string[]> {
  const rows = await asSystem(db, (tx) => tx<{ v: string }[]>`SELECT id || '@' || version AS v FROM bookmarks WHERE workspace_id = ${workspaceId} ORDER BY 1`);
  return rows.map((row) => row.v);
}

const links = (bookmarks: readonly string[], target: string): string[] => bookmarks.map((id) => `${id}/${target}`).toSorted();

describe("the failure scenario: tagging ids that include another member's bookmarks", () => {
  it("tags the caller's own, leaves another member's and another workspace's bookmarks untouched, and counts the rest as not reached", async () => {
    const workspace = await workspaceOf();
    const other = await workspaceOf();
    const own = [await seedBookmark(workspace.id, workspace.b), await seedBookmark(workspace.id, workspace.b)];
    const theirs = [await seedBookmark(workspace.id, workspace.a), await seedBookmark(workspace.id, workspace.a)];
    const foreign = [await seedBookmark(other.id, other.a)];
    const archived = [await seedBookmark(workspace.id, workspace.b, true)];
    const tag = await seedTag(workspace.id, workspace.b, "Mine");
    const versionsBefore = await versionsOf(workspace.id);
    const foreignBefore = { links: await tagLinks(other.id), versions: await versionsOf(other.id) };

    const result = await inTenant({ accountId: workspace.b, workspaceId: workspace.id }, (tx) =>
      bookmarkRepository(tx).tag({ bookmarkIds: [...own, ...theirs, ...foreign, ...archived, freshId()], ownerId: workspace.b, tagIds: [tag], mode: "add" }),
    );

    expect(result).toEqual({ kind: "done", affected: 2 });
    expect(await tagLinks(workspace.id)).toEqual(links(own, tag));
    expect(await tagLinks(other.id)).toEqual(foreignBefore.links);
    expect(await versionsOf(workspace.id)).toEqual(versionsBefore);
    expect(await versionsOf(other.id)).toEqual(foreignBefore.versions);
  });
});

describe("tagging", () => {
  it("answers target_not_found, writing nothing, for a tag of another member's, of another workspace's or unknown, even when one of several is the caller's", async () => {
    const workspace = await workspaceOf();
    const other = await workspaceOf();
    const own = await seedBookmark(workspace.id, workspace.b);
    const mine = await seedTag(workspace.id, workspace.b, "Mine");
    const ofA = await seedTag(workspace.id, workspace.a, "Of A");
    const ofOther = await seedTag(other.id, other.a, "Elsewhere");

    for (const wrong of [ofA, ofOther, freshId()]) {
      const result = await inTenant({ accountId: workspace.b, workspaceId: workspace.id }, (tx) =>
        bookmarkRepository(tx).tag({ bookmarkIds: [own], ownerId: workspace.b, tagIds: [mine, wrong], mode: "add" }),
      );
      expect(result).toEqual({ kind: "target_not_found" });
    }
    const forEmpty = await inTenant({ accountId: workspace.b, workspaceId: workspace.id }, (tx) =>
      bookmarkRepository(tx).tag({ bookmarkIds: [], ownerId: workspace.b, tagIds: [ofA], mode: "remove" }),
    );

    expect(forEmpty).toEqual({ kind: "target_not_found" });
    expect(await tagLinks(workspace.id)).toEqual([]);
  });

  it("adds a tag a bookmark carries already without a second link, and removes it from the ones that carry it, counting every owned bookmark", async () => {
    const workspace = await workspaceOf();
    const [first, second, third] = [await seedBookmark(workspace.id, workspace.a), await seedBookmark(workspace.id, workspace.a), await seedBookmark(workspace.id, workspace.a)];
    const [tag, keep] = [await seedTag(workspace.id, workspace.a, "Tag"), await seedTag(workspace.id, workspace.a, "Keep")];
    await tagLink(workspace.id, first, tag);
    await tagLink(workspace.id, first, keep);
    const tenant = { accountId: workspace.a, workspaceId: workspace.id };

    const added = await inTenant(tenant, (tx) => bookmarkRepository(tx).tag({ bookmarkIds: [first, second], ownerId: workspace.a, tagIds: [tag], mode: "add" }));
    expect(added).toEqual({ kind: "done", affected: 2 });
    expect(await tagLinks(workspace.id)).toEqual([...links([first, second], tag), `${first}/${keep}`].toSorted());

    const removed = await inTenant(tenant, (tx) => bookmarkRepository(tx).tag({ bookmarkIds: [first, third], ownerId: workspace.a, tagIds: [tag], mode: "remove" }));
    expect(removed).toEqual({ kind: "done", affected: 2 });
    expect(await tagLinks(workspace.id)).toEqual([`${second}/${tag}`, `${first}/${keep}`].toSorted());
  });

  it("refuses an account other than the one of the transaction", async () => {
    const workspace = await workspaceOf();

    await expect(
      inTenant({ accountId: workspace.b, workspaceId: workspace.id }, (tx) => bookmarkRepository(tx).tag({ bookmarkIds: [], ownerId: workspace.a, tagIds: [], mode: "add" })),
    ).rejects.toThrow("only the account of the transaction tags its own bookmarks");
  });
});

describe("the preview of adding tags", () => {
  it("answers the tag set the caller's bookmarks would carry, with how many carry each and how many get it, and writes nothing", async () => {
    const workspace = await workspaceOf();
    const [first, second, third] = [await seedBookmark(workspace.id, workspace.b), await seedBookmark(workspace.id, workspace.b), await seedBookmark(workspace.id, workspace.b)];
    const theirs = await seedBookmark(workspace.id, workspace.a);
    const archived = await seedBookmark(workspace.id, workspace.b, true);
    const [beta, alpha, gamma] = [await seedTag(workspace.id, workspace.b, "beta"), await seedTag(workspace.id, workspace.b, "Alpha"), await seedTag(workspace.id, workspace.b, "gamma")];
    const ofA = await seedTag(workspace.id, workspace.a, "Of A");
    await tagLink(workspace.id, first, beta);
    await tagLink(workspace.id, second, beta);
    await tagLink(workspace.id, third, gamma);
    await tagLink(workspace.id, theirs, ofA);
    await tagLink(workspace.id, archived, gamma);
    const linksBefore = await tagLinks(workspace.id);

    const result = await inTenant({ accountId: workspace.b, workspaceId: workspace.id }, (tx) =>
      bookmarkRepository(tx).previewTags({ bookmarkIds: [first, second, third, theirs, archived], ownerId: workspace.b, tagIds: [alpha, beta] }),
    );

    expect(result).toEqual({
      kind: "previewed",
      affected: 3,
      tags: [
        { id: alpha, name: "Alpha", bookmarkCount: 3, added: 3 },
        { id: beta, name: "beta", bookmarkCount: 3, added: 1 },
        { id: gamma, name: "gamma", bookmarkCount: 1, added: 0 },
      ],
    });
    expect(await tagLinks(workspace.id)).toEqual(linksBefore);
  });

  it("answers target_not_found for a tag that is not the caller's, and lists the added tags for no bookmark at all", async () => {
    const workspace = await workspaceOf();
    const [mine, ofA] = [await seedTag(workspace.id, workspace.b, "Mine"), await seedTag(workspace.id, workspace.a, "Of A")];
    const tenant = { accountId: workspace.b, workspaceId: workspace.id };

    expect(await inTenant(tenant, (tx) => bookmarkRepository(tx).previewTags({ bookmarkIds: [], ownerId: workspace.b, tagIds: [mine, ofA] }))).toEqual({ kind: "target_not_found" });
    expect(await inTenant(tenant, (tx) => bookmarkRepository(tx).previewTags({ bookmarkIds: [], ownerId: workspace.b, tagIds: [mine] }))).toEqual({
      kind: "previewed",
      affected: 0,
      tags: [{ id: mine, name: "Mine", bookmarkCount: 0, added: 0 }],
    });
  });
});

describe("filing", () => {
  it("adds the bookmarks to a folder besides the ones they are in, and counts a bookmark that is in it already", async () => {
    const workspace = await workspaceOf();
    const [first, second] = [await seedBookmark(workspace.id, workspace.a), await seedBookmark(workspace.id, workspace.a)];
    const [target, other] = [await seedFolder(workspace.id, workspace.a, "Target"), await seedFolder(workspace.id, workspace.a, "Other")];
    await file(workspace.id, other, first);
    await file(workspace.id, target, second);

    const result = await inTenant({ accountId: workspace.a, workspaceId: workspace.id }, (tx) =>
      bookmarkRepository(tx).fileIn({ bookmarkIds: [first, second], ownerId: workspace.a, folderId: target, mode: "add" }),
    );

    expect(result).toEqual({ kind: "done", affected: 2 });
    expect(await folderLinks(workspace.id)).toEqual([...links([first, second], target), `${first}/${other}`].toSorted());
  });

  it("moves the bookmarks to a folder alone: every link to another folder goes, and a bookmark that was not selected keeps its links", async () => {
    const workspace = await workspaceOf();
    const [first, second, kept] = [await seedBookmark(workspace.id, workspace.a), await seedBookmark(workspace.id, workspace.a), await seedBookmark(workspace.id, workspace.a)];
    const [target, other, third] = [await seedFolder(workspace.id, workspace.a, "Target"), await seedFolder(workspace.id, workspace.a, "Other"), await seedFolder(workspace.id, workspace.a, "Third")];
    await file(workspace.id, other, first);
    await file(workspace.id, third, first);
    await file(workspace.id, target, second);
    await file(workspace.id, other, kept);

    const result = await inTenant({ accountId: workspace.a, workspaceId: workspace.id }, (tx) =>
      bookmarkRepository(tx).fileIn({ bookmarkIds: [first, second], ownerId: workspace.a, folderId: target, mode: "move" }),
    );

    expect(result).toEqual({ kind: "done", affected: 2 });
    expect(await folderLinks(workspace.id)).toEqual([...links([first, second], target), `${kept}/${other}`].toSorted());
  });

  it("removes the bookmarks from the folder alone, leaving their other folders", async () => {
    const workspace = await workspaceOf();
    const [first, second] = [await seedBookmark(workspace.id, workspace.a), await seedBookmark(workspace.id, workspace.a)];
    const [target, other] = [await seedFolder(workspace.id, workspace.a, "Target"), await seedFolder(workspace.id, workspace.a, "Other")];
    await file(workspace.id, target, first);
    await file(workspace.id, other, first);

    const result = await inTenant({ accountId: workspace.a, workspaceId: workspace.id }, (tx) =>
      bookmarkRepository(tx).fileIn({ bookmarkIds: [first, second], ownerId: workspace.a, folderId: target, mode: "remove" }),
    );

    expect(result).toEqual({ kind: "done", affected: 2 });
    expect(await folderLinks(workspace.id)).toEqual([`${first}/${other}`]);
  });

  it("files the caller's own bookmarks only: another member's, another workspace's and a plan-archived one are untouched and not counted, and no version moves", async () => {
    const workspace = await workspaceOf();
    const other = await workspaceOf();
    const own = await seedBookmark(workspace.id, workspace.b);
    const theirs = await seedBookmark(workspace.id, workspace.a);
    const archived = await seedBookmark(workspace.id, workspace.b, true);
    const foreign = await seedBookmark(other.id, other.a);
    const [target, formerly] = [await seedFolder(workspace.id, workspace.b, "Target"), await seedFolder(workspace.id, workspace.a, "Formerly")];
    await file(workspace.id, formerly, theirs);
    const versionsBefore = await versionsOf(workspace.id);

    const result = await inTenant({ accountId: workspace.b, workspaceId: workspace.id }, (tx) =>
      bookmarkRepository(tx).fileIn({ bookmarkIds: [own, theirs, archived, foreign], ownerId: workspace.b, folderId: target, mode: "move" }),
    );

    expect(result).toEqual({ kind: "done", affected: 1 });
    expect(await folderLinks(workspace.id)).toEqual([`${own}/${target}`, `${theirs}/${formerly}`].toSorted());
    expect(await folderLinks(other.id)).toEqual([]);
    expect(await versionsOf(workspace.id)).toEqual(versionsBefore);
  });

  it("answers target_not_found, writing nothing, for a folder that is another member's, another workspace's or unknown, and for every mode", async () => {
    const workspace = await workspaceOf();
    const other = await workspaceOf();
    const own = await seedBookmark(workspace.id, workspace.b);
    const [mine, ofA, ofOther] = [await seedFolder(workspace.id, workspace.b, "Mine"), await seedFolder(workspace.id, workspace.a, "Of A"), await seedFolder(other.id, other.a, "Elsewhere")];
    await file(workspace.id, mine, own);

    for (const wrong of [ofA, ofOther, freshId()]) {
      for (const mode of ["add", "move", "remove"] as const) {
        const result = await inTenant({ accountId: workspace.b, workspaceId: workspace.id }, (tx) =>
          bookmarkRepository(tx).fileIn({ bookmarkIds: [own], ownerId: workspace.b, folderId: wrong, mode }),
        );
        expect(result).toEqual({ kind: "target_not_found" });
      }
    }

    expect(await folderLinks(workspace.id)).toEqual([`${own}/${mine}`]);
  });
});

describe("two bulk calls over the same bookmarks", () => {
  it("both finish when they name the bookmarks in opposite orders, since the rows are locked in the order of their identifiers", async () => {
    const workspace = await workspaceOf();
    const bookmarks: string[] = [];
    for (let index = 0; index < 40; index += 1) {
      bookmarks.push(await seedBookmark(workspace.id, workspace.a));
    }
    const [tagOne, tagTwo] = [await seedTag(workspace.id, workspace.a, "One"), await seedTag(workspace.id, workspace.a, "Two")];
    const tenant = { accountId: workspace.a, workspaceId: workspace.id };

    const [one, two] = await Promise.all([
      inTenant(tenant, (tx) => bookmarkRepository(tx).tag({ bookmarkIds: bookmarks, ownerId: workspace.a, tagIds: [tagOne], mode: "add" })),
      inTenant(tenant, (tx) => bookmarkRepository(tx).tag({ bookmarkIds: bookmarks.toReversed(), ownerId: workspace.a, tagIds: [tagTwo], mode: "add" })),
    ]);

    expect(one).toEqual({ kind: "done", affected: 40 });
    expect(two).toEqual({ kind: "done", affected: 40 });
    expect(await tagLinks(workspace.id)).toHaveLength(80);
  });
});
