import { eq } from "drizzle-orm";
import { setTimeout as sleep } from "node:timers/promises";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountDeletionRepository, isTagNameTaken, listRepositoryMethods, memberRepository, tagRepository, workspacePurgeOrder } from "../src/index.ts";
import { insertTagLinks, lockTaggingTags } from "../src/repositories/tag-links.ts";
import { tags } from "../src/schema/tags.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// The tags of a member (doc 05 section 2.4, doc 02 section 7.2, doc 10 T2). The failure scenario: in one workspace member B lists,
// renames and deletes member A's tag by identifier, and with the application's predicates left out reads, changes and deletes no tag
// row of A, because the policy of the table names the owner. Besides that: a tag of one workspace is no tag of the same account's
// other workspace; a name is unique per owner without regard to case and a collision ends neither the transaction nor another
// owner's use of the name; a merge moves the links of a tag to another of the same owner in one transaction, and a merge that is refused or
// fails changes nothing; the length of a name is the table's own rule; the links of a tag are as private as the tag and go with
// it, with the membership that owns it and with the workspace; and the count of a tag leaves plan-archived bookmarks out.

const HOOK_TIMEOUT_MS = 300_000;
const CHECK_VIOLATION = "23514";
const INSUFFICIENT_PRIVILEGE = "42501";

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
  await seedAccount(db, { id, email: `tags${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub" });
  return id;
}

interface Workspace {
  readonly id: string;
  readonly members: readonly string[];
}

async function workspaceOf(memberCount = 2): Promise<Workspace> {
  const id = await seedWorkspace(db, { name: "Tags test" });
  const members: string[] = [];
  for (let index = 0; index < memberCount; index += 1) {
    const accountId = await account();
    await seedMember(db, { workspaceId: id, accountId, role: index === 0 ? "owner" : "member" });
    members.push(accountId);
  }
  return { id, members };
}

function memberOf(workspace: Workspace, index: number): string {
  const member = workspace.members[index];
  if (member === undefined) {
    throw new Error("no such member");
  }
  return member;
}

function inTenant<T>(tenant: { accountId: string; workspaceId?: string }, work: Parameters<typeof db.tenant.withTenant<T>>[1]): Promise<T> {
  return db.tenant.withTenant({ ...tenant, requestId: "tags-test" }, work);
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

/** Writes a tag as slugbase_system, which stands for the operations that write in ways a request may not. */
async function seedTag(workspaceId: string, ownerId: string, name: string, id = freshId()): Promise<string> {
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

async function link(workspaceId: string, bookmarkId: string, tagId: string): Promise<void> {
  await asSystem(db, (tx) => tx`INSERT INTO bookmark_tags (workspace_id, bookmark_id, tag_id) VALUES (${workspaceId}, ${bookmarkId}, ${tagId})`);
}

async function storedTags(workspaceId: string): Promise<{ id: string; name: string; owner_id: string }[]> {
  return asSystem(db, (tx) => tx<{ id: string; name: string; owner_id: string }[]>`SELECT id, name, owner_id FROM tags WHERE workspace_id = ${workspaceId} ORDER BY name`);
}

async function storedLinks(workspaceId: string): Promise<number> {
  const rows = await asSystem(db, (tx) => tx<{ n: string }[]>`SELECT count(*)::text AS n FROM bookmark_tags WHERE workspace_id = ${workspaceId}`);
  return Number(rows[0]?.n);
}

const newTag = (ownerId: string, name: string) => ({ id: freshId(), ownerId, name });

describe("the tables", () => {
  it("has the columns, keys, checks and index of doc 05 section 2.4", async () => {
    const columns = await db.owner<{ table_name: string; column_name: string; is_nullable: string; data_type: string; udt_name: string }[]>`
      SELECT table_name, column_name, is_nullable, data_type, udt_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name IN ('tags', 'bookmark_tags') ORDER BY table_name, ordinal_position`;
    expect(columns.filter((column) => column.table_name === "tags").map((column) => [column.column_name, column.udt_name, column.is_nullable])).toEqual([
      ["id", "uuid", "NO"],
      ["workspace_id", "uuid", "NO"],
      ["owner_id", "uuid", "NO"],
      ["name", "citext", "NO"],
      ["created_at", "timestamptz", "NO"],
    ]);
    expect(columns.filter((column) => column.table_name === "bookmark_tags").map((column) => [column.column_name, column.is_nullable])).toEqual([
      ["workspace_id", "NO"],
      ["bookmark_id", "NO"],
      ["tag_id", "NO"],
    ]);

    const constraints = await db.owner<{ conname: string; definition: string }[]>`
      SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid IN ('public.tags'::regclass, 'public.bookmark_tags'::regclass) AND contype <> 'n' ORDER BY conname`;
    const byName = new Map(constraints.map((constraint) => [constraint.conname, constraint.definition]));
    expect([...byName.keys()]).toEqual([
      "bookmark_tags_bookmark_fkey",
      "bookmark_tags_pkey",
      "bookmark_tags_tag_fkey",
      "tags_name_check",
      "tags_owner_fkey",
      "tags_owner_name_key",
      "tags_pkey",
      "tags_workspace_id_id_key",
      "tags_workspace_id_workspaces_id_fk",
    ]);
    expect(byName.get("tags_owner_name_key")).toBe("UNIQUE (workspace_id, owner_id, name)");
    expect(byName.get("tags_owner_fkey")).toBe("FOREIGN KEY (workspace_id, owner_id) REFERENCES workspace_members(workspace_id, account_id) ON DELETE CASCADE");
    expect(byName.get("bookmark_tags_pkey")).toBe("PRIMARY KEY (bookmark_id, tag_id)");
    expect(byName.get("bookmark_tags_bookmark_fkey")).toBe("FOREIGN KEY (workspace_id, bookmark_id) REFERENCES bookmarks(workspace_id, id) ON DELETE CASCADE");
    expect(byName.get("bookmark_tags_tag_fkey")).toBe("FOREIGN KEY (workspace_id, tag_id) REFERENCES tags(workspace_id, id) ON DELETE CASCADE");

    const indexes = await db.owner<{ indexdef: string }[]>`SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'bookmark_tags_tag_idx'`;
    expect(indexes[0]?.indexdef).toContain("(workspace_id, tag_id)");
  });

  it("has row-level security enabled and forced on both, with the owner in the predicate of every policy of tags and of the links", async () => {
    const tables = await db.owner<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN ('tags', 'bookmark_tags') ORDER BY relname`;
    expect(tables).toEqual([
      { relname: "bookmark_tags", relrowsecurity: true, relforcerowsecurity: true },
      { relname: "tags", relrowsecurity: true, relforcerowsecurity: true },
    ]);

    const policies = await db.owner<{ tablename: string; policyname: string; cmd: string; qual: string | null; with_check: string | null }[]>`
      SELECT tablename, policyname, cmd, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('tags', 'bookmark_tags') ORDER BY tablename, cmd = 'SELECT' DESC, policyname`;
    expect(policies.map((policy) => [policy.tablename, policy.cmd])).toEqual([
      ["bookmark_tags", "SELECT"],
      ["bookmark_tags", "DELETE"],
      ["bookmark_tags", "INSERT"],
      ["tags", "SELECT"],
      ["tags", "DELETE"],
      ["tags", "INSERT"],
      ["tags", "UPDATE"],
    ]);
    for (const policy of policies) {
      for (const predicate of [policy.qual, policy.with_check]) {
        if (predicate !== null) {
          expect(predicate).toContain("app_workspace_id()");
          expect(predicate).toContain("app_account_id()");
        }
      }
    }
  });

  it("lets slugbase_app insert the columns of a creation, rename and delete, and read, insert and delete the links, and nothing more", async () => {
    const workspace = await workspaceOf(1);
    const owner = memberOf(workspace, 0);
    const tag = await seedTag(workspace.id, owner, "Existing");

    await expect(
      appAs({ accountId: owner, workspaceId: workspace.id }, (tx) => tx`INSERT INTO tags (id, workspace_id, owner_id, name, created_at) VALUES (${freshId()}, ${workspace.id}, ${owner}, 'Dated', now())`),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    await expect(
      appAs({ accountId: owner, workspaceId: workspace.id }, (tx) => tx`UPDATE tags SET owner_id = owner_id WHERE id = ${tag}`),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    // A link names a bookmark the owner owns (the policy of the insert says so, src/sql/550-bookmark-tagging.sql), and a link has nothing to update.
    await expect(
      appAs({ accountId: owner, workspaceId: workspace.id }, (tx) => tx`INSERT INTO bookmark_tags (workspace_id, bookmark_id, tag_id) VALUES (${workspace.id}, ${freshId()}, ${tag})`),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    await expect(appAs({ accountId: owner, workspaceId: workspace.id }, (tx) => tx`UPDATE bookmark_tags SET tag_id = tag_id`)).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    await expect(appAs({ accountId: owner, workspaceId: workspace.id }, (tx) => tx`DELETE FROM bookmark_tags`)).resolves.toHaveLength(0);
  });
});

describe("a tag is its owner's alone (T2)", () => {
  it("is not listed, renamed or deleted by another member of the workspace, who finds nothing at its identifier", async () => {
    const workspace = await workspaceOf(2);
    const [a, b] = [memberOf(workspace, 0), memberOf(workspace, 1)];
    const tagOfA = await seedTag(workspace.id, a, "Private to A");
    const tagOfB = await seedTag(workspace.id, b, "Private to B");
    const before = await storedTags(workspace.id);

    const outcome = await inTenant({ accountId: b, workspaceId: workspace.id }, async (tx) => {
      const repository = tagRepository(tx);
      return {
        listed: (await repository.list({ ownerId: b, sort: "name", after: undefined, limit: 100 })).map((tag) => tag.id),
        listedByCount: (await repository.list({ ownerId: b, sort: "count", after: undefined, limit: 100 })).map((tag) => tag.id),
        renamed: await repository.rename({ tagId: tagOfA, ownerId: b, name: "Taken over" }),
        deleted: await repository.remove({ tagId: tagOfA, ownerId: b }),
      };
    });

    expect(outcome).toEqual({ listed: [tagOfB], listedByCount: [tagOfB], renamed: { kind: "not_found" }, deleted: false });
    expect(await storedTags(workspace.id)).toEqual(before);
  });

  it("is not read, changed or deleted with the application's predicates left out: row-level security alone names the owner", async () => {
    const workspace = await workspaceOf(2);
    const [a, b] = [memberOf(workspace, 0), memberOf(workspace, 1)];
    const tagOfA = await seedTag(workspace.id, a, "Private to A");
    const tagOfB = await seedTag(workspace.id, b, "Private to B");
    const before = await storedTags(workspace.id);
    const entry = (method: "select" | "update" | "delete") => {
      const found = listRepositoryMethods().find((candidate) => candidate.repository === "tags" && candidate.method === method);
      if (found === undefined) {
        throw new Error(`the registry has no tags.${method}`);
      }
      return found;
    };

    const outcome = await inTenant({ accountId: b, workspaceId: workspace.id }, async (tx) => ({
      selected: (await entry("select").invokeRlsOnly(tx)).map((row) => (row as { id: string }).id),
      selectedAtTheTagOfA: await entry("select").invokeRlsOnly(tx, { where: eq(tags.id, tagOfA) }),
      updatedAtTheTagOfA: await entry("update").invokeRlsOnly(tx, { set: { name: "Taken over" }, where: eq(tags.id, tagOfA) }),
      deletedAtTheTagOfA: await entry("delete").invokeRlsOnly(tx, { where: eq(tags.id, tagOfA) }),
    }));
    const raw = await appAs({ accountId: b, workspaceId: workspace.id }, async (tx) => ({
      selected: (await tx<{ id: string }[]>`SELECT id FROM tags`).map((row) => row.id),
      updated: (await tx<{ id: string }[]>`UPDATE tags SET name = 'Everyone''s' RETURNING id`).map((row) => row.id),
      deleted: (await tx<{ id: string }[]>`DELETE FROM tags RETURNING id`).map((row) => row.id),
    }));

    expect(outcome.selected).toEqual([tagOfB]);
    expect(outcome.selectedAtTheTagOfA).toEqual([]);
    expect(outcome.updatedAtTheTagOfA).toEqual([]);
    expect(outcome.deletedAtTheTagOfA).toEqual([]);
    expect(raw).toEqual({ selected: [tagOfB], updated: [tagOfB], deleted: [tagOfB] });
    expect(await storedTags(workspace.id)).toEqual(before.filter((tag) => tag.id === tagOfA));
  });

  it("cannot be created for another member, even by naming that member, with the application's stamp left out", async () => {
    const workspace = await workspaceOf(2);
    const [a, b] = [memberOf(workspace, 0), memberOf(workspace, 1)];

    const refusal = await refusedWith(
      appAs({ accountId: b, workspaceId: workspace.id }, (tx) => tx`INSERT INTO tags (id, workspace_id, owner_id, name) VALUES (${freshId()}, ${workspace.id}, ${a}, 'Planted')`),
    );

    expect(refusal).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await storedTags(workspace.id)).toEqual([]);
  });

  it("cannot be moved to another workspace by an update", async () => {
    const workspace = await workspaceOf(2);
    const other = await workspaceOf(1);
    const a = memberOf(workspace, 0);
    await seedTag(workspace.id, a, "Mine");

    await expect(appAs({ accountId: a, workspaceId: workspace.id }, (tx) => tx`UPDATE tags SET workspace_id = ${other.id}`)).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    expect((await storedTags(workspace.id)).map((tag) => tag.owner_id)).toEqual([a]);
  });

  it("is a tag of the workspace it was made in: the same account lists none of it from another workspace", async () => {
    const first = await workspaceOf(1);
    const second = await workspaceOf(0);
    const member = memberOf(first, 0);
    await seedMember(db, { workspaceId: second.id, accountId: member, role: "member" });
    const tag = await seedTag(first.id, member, "Only here");

    const outcome = await inTenant({ accountId: member, workspaceId: second.id }, async (tx) => {
      const repository = tagRepository(tx);
      return {
        listed: await repository.list({ ownerId: member, sort: "name", after: undefined, limit: 100 }),
        renamed: await repository.rename({ tagId: tag, ownerId: member, name: "Moved" }),
        deleted: await repository.remove({ tagId: tag, ownerId: member }),
      };
    });

    expect(outcome).toEqual({ listed: [], renamed: { kind: "not_found" }, deleted: false });
    expect((await storedTags(first.id)).map((row) => row.name)).toEqual(["Only here"]);
  });

  it("refuses a request that names an account other than the one of the transaction", async () => {
    const workspace = await workspaceOf(2);
    const [a, b] = [memberOf(workspace, 0), memberOf(workspace, 1)];

    await expect(inTenant({ accountId: b, workspaceId: workspace.id }, (tx) => tagRepository(tx).list({ ownerId: a, sort: "name", after: undefined, limit: 100 }))).rejects.toThrow(
      "the account of the transaction",
    );
  });
});

describe("the name of a tag", () => {
  it("is stored as entered, and a second tag of the same owner with the same name in any case is name_taken without ending the transaction", async () => {
    const workspace = await workspaceOf(1);
    const owner = memberOf(workspace, 0);

    const outcome = await inTenant({ accountId: owner, workspaceId: workspace.id }, async (tx) => {
      const repository = tagRepository(tx);
      const first = await repository.create(newTag(owner, "Read Later"));
      const same = await repository.create(newTag(owner, "Read Later"));
      const otherCase = await repository.create(newTag(owner, "READ later"));
      // The conflicting inserts wrote nothing and raised nothing, so the transaction still works.
      const next = await repository.create(newTag(owner, "Other"));
      return { first, same, otherCase, next, listed: (await repository.list({ ownerId: owner, sort: "name", after: undefined, limit: 100 })).map((tag) => tag.name) };
    });

    expect(outcome.first).toMatchObject({ kind: "created", tag: { name: "Read Later", bookmarkCount: 0 } });
    expect(outcome.same).toEqual({ kind: "name_taken" });
    expect(outcome.otherCase).toEqual({ kind: "name_taken" });
    expect(outcome.next).toMatchObject({ kind: "created" });
    expect(outcome.listed).toEqual(["Other", "Read Later"]);
    expect((await storedTags(workspace.id)).map((tag) => tag.name)).toEqual(["Other", "Read Later"]);
  });

  it("may be used by every owner: two members have a tag of the same name, and one cannot take the name from the other", async () => {
    const workspace = await workspaceOf(2);
    const [a, b] = [memberOf(workspace, 0), memberOf(workspace, 1)];

    const first = await inTenant({ accountId: a, workspaceId: workspace.id }, (tx) => tagRepository(tx).create(newTag(a, "Shared name")));
    const second = await inTenant({ accountId: b, workspaceId: workspace.id }, (tx) => tagRepository(tx).create(newTag(b, "shared NAME")));
    const again = await inTenant({ accountId: b, workspaceId: workspace.id }, (tx) => tagRepository(tx).create(newTag(b, "Shared Name")));

    expect(first.kind).toBe("created");
    expect(second.kind).toBe("created");
    expect(again).toEqual({ kind: "name_taken" });
  });

  it("renames to a free name, to the same name in another case, and to nothing new, and refuses a name another tag of the owner has", async () => {
    const workspace = await workspaceOf(1);
    const owner = memberOf(workspace, 0);
    const first = await seedTag(workspace.id, owner, "Alpha");
    await seedTag(workspace.id, owner, "Beta");

    const outcome = await inTenant({ accountId: owner, workspaceId: workspace.id }, async (tx) => {
      const repository = tagRepository(tx);
      return {
        free: await repository.rename({ tagId: first, ownerId: owner, name: "Gamma" }),
        caseOnly: await repository.rename({ tagId: first, ownerId: owner, name: "GAMMA" }),
        unchanged: await repository.rename({ tagId: first, ownerId: owner, name: "GAMMA" }),
        taken: await repository.rename({ tagId: first, ownerId: owner, name: "beta" }),
        afterwards: (await repository.list({ ownerId: owner, sort: "name", after: undefined, limit: 100 })).map((tag) => tag.name),
      };
    });

    expect(outcome.free).toMatchObject({ kind: "renamed", tag: { id: first, name: "Gamma" } });
    expect(outcome.caseOnly).toMatchObject({ kind: "renamed", tag: { id: first, name: "GAMMA" } });
    expect(outcome.unchanged).toMatchObject({ kind: "unchanged", tag: { id: first, name: "GAMMA" } });
    expect(outcome.taken).toEqual({ kind: "name_taken" });
    expect(outcome.afterwards).toEqual(["Beta", "GAMMA"]);
  });

  it("is refused by the table when it is empty or longer than 40 characters, and kept at 40", async () => {
    const workspace = await workspaceOf(1);
    const owner = memberOf(workspace, 0);
    const insert = (name: string) =>
      refusedWith(appAs({ accountId: owner, workspaceId: workspace.id }, (tx) => tx`INSERT INTO tags (id, workspace_id, owner_id, name) VALUES (${freshId()}, ${workspace.id}, ${owner}, ${name})`));

    expect(await insert("")).toBe(CHECK_VIOLATION);
    expect(await insert("x".repeat(41))).toBe(CHECK_VIOLATION);
    expect(await insert("x".repeat(40))).toBeUndefined();
    expect(await insert("😀".repeat(40))).toBeUndefined();
  });

  it("answers the creation of two tags with one name at the same time as one created and one name_taken", async () => {
    const workspace = await workspaceOf(1);
    const owner = memberOf(workspace, 0);

    const outcomes = await Promise.all(
      [1, 2, 3, 4].map(() => inTenant({ accountId: owner, workspaceId: workspace.id }, (tx) => tagRepository(tx).create(newTag(owner, "Race")))),
    );

    expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(["created", "name_taken", "name_taken", "name_taken"]);
    expect(await storedTags(workspace.id)).toHaveLength(1);
  });

  it("answers two overlapping renames to one name with one rename, and the other as a name that is taken", async () => {
    const workspace = await workspaceOf(1);
    const owner = memberOf(workspace, 0);
    const [first, second] = [await seedTag(workspace.id, owner, "First"), await seedTag(workspace.id, owner, "Second")];
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let renamedFirst: () => void = () => undefined;
    const renamed = new Promise<void>((resolve) => {
      renamedFirst = resolve;
    });

    const winner = inTenant({ accountId: owner, workspaceId: workspace.id }, async (tx) => {
      const outcome = await tagRepository(tx).rename({ tagId: first, ownerId: owner, name: "Contested" });
      renamedFirst();
      await held;
      return outcome;
    });
    await renamed;
    // The winner's rename is not committed, so this one finds the name free and meets the winner at the key of the table.
    const loser = inTenant({ accountId: owner, workspaceId: workspace.id }, (tx) => tagRepository(tx).rename({ tagId: second, ownerId: owner, name: "contested" })).then(
      (outcome) => ({ taken: outcome.kind === "name_taken" }),
      (error: unknown) => ({ taken: isTagNameTaken(error) }),
    );
    await sleep(300);
    release();

    expect((await winner).kind).toBe("renamed");
    expect(await loser).toEqual({ taken: true });
    expect((await storedTags(workspace.id)).map((tag) => tag.name)).toEqual(["Contested", "Second"]);
  });
});

describe("the count and the links of a tag", () => {
  it("counts the bookmarks a tag carries, leaves plan-archived ones out, and sorts by that count and then by name", async () => {
    const workspace = await workspaceOf(1);
    const owner = memberOf(workspace, 0);
    const busy = await seedTag(workspace.id, owner, "Busy");
    const quiet = await seedTag(workspace.id, owner, "Quiet");
    const archivedOnly = await seedTag(workspace.id, owner, "Archived only");
    const empty = await seedTag(workspace.id, owner, "Empty");
    const [one, two, three] = [await seedBookmark(workspace.id, owner), await seedBookmark(workspace.id, owner), await seedBookmark(workspace.id, owner, true)];
    await link(workspace.id, one, busy);
    await link(workspace.id, two, busy);
    await link(workspace.id, three, busy);
    await link(workspace.id, one, quiet);
    await link(workspace.id, three, archivedOnly);

    const outcome = await inTenant({ accountId: owner, workspaceId: workspace.id }, async (tx) => {
      const repository = tagRepository(tx);
      return {
        byName: (await repository.list({ ownerId: owner, sort: "name", after: undefined, limit: 100 })).map((tag) => [tag.name, tag.bookmarkCount]),
        byCount: (await repository.list({ ownerId: owner, sort: "count", after: undefined, limit: 100 })).map((tag) => [tag.name, tag.bookmarkCount]),
      };
    });

    expect(outcome.byName).toEqual([["Archived only", 0], ["Busy", 2], ["Empty", 0], ["Quiet", 1]]);
    expect(outcome.byCount).toEqual([["Busy", 2], ["Quiet", 1], ["Archived only", 0], ["Empty", 0]]);
    expect([busy, quiet, archivedOnly, empty]).toHaveLength(4);
  });

  it("resumes a page after the last tag of the previous one in both sorts, one tag once, with ties on the count broken by name", async () => {
    const workspace = await workspaceOf(2);
    const [owner, other] = [memberOf(workspace, 0), memberOf(workspace, 1)];
    const names = ["Delta", "alpha", "Charlie", "Bravo", "Echo"];
    const ids = new Map<string, string>();
    for (const name of names) {
      ids.set(name, await seedTag(workspace.id, owner, name));
    }
    await seedTag(workspace.id, other, "Foreign");
    for (const [name, links] of [["Delta", 2], ["Charlie", 2], ["Bravo", 1]] as const) {
      for (let count = 0; count < links; count += 1) {
        await link(workspace.id, await seedBookmark(workspace.id, owner), ids.get(name) ?? "");
      }
    }

    const outcome = await inTenant({ accountId: owner, workspaceId: workspace.id }, async (tx) => {
      const repository = tagRepository(tx);
      const pages = async (sort: "name" | "count") => {
        const seen: string[][] = [];
        let after: { count: number | undefined; name: string; id: string } | undefined;
        for (let guard = 0; guard < 10; guard += 1) {
          const page = await repository.list({ ownerId: owner, sort, after, limit: 2 });
          if (page.length === 0) {
            break;
          }
          seen.push(page.map((tag) => tag.name));
          const last = page[page.length - 1];
          after = last === undefined ? undefined : { count: sort === "count" ? last.bookmarkCount : undefined, name: last.name, id: last.id };
        }
        return seen;
      };
      return { byName: await pages("name"), byCount: await pages("count") };
    });

    expect(outcome.byName).toEqual([["alpha", "Bravo"], ["Charlie", "Delta"], ["Echo"]]);
    expect(outcome.byCount).toEqual([["Charlie", "Delta"], ["Bravo", "alpha"], ["Echo"]]);
  });

  it("counts the tags of the owner alone, at most the limit it is given", async () => {
    const workspace = await workspaceOf(2);
    const [owner, other] = [memberOf(workspace, 0), memberOf(workspace, 1)];
    for (const name of ["One", "Two", "Three"]) {
      await seedTag(workspace.id, owner, name);
    }
    await seedTag(workspace.id, other, "Foreign");

    const outcome = await inTenant({ accountId: owner, workspaceId: workspace.id }, async (tx) => {
      const repository = tagRepository(tx);
      return { all: await repository.count(owner, 10), capped: await repository.count(owner, 2) };
    });

    expect(outcome).toEqual({ all: 3, capped: 2 });
  });

  it("shows the links of a tag to its owner alone", async () => {
    const workspace = await workspaceOf(2);
    const [a, b] = [memberOf(workspace, 0), memberOf(workspace, 1)];
    const tagOfA = await seedTag(workspace.id, a, "Linked");
    const bookmark = await seedBookmark(workspace.id, a);
    await link(workspace.id, bookmark, tagOfA);

    const read = (accountId: string) => appAs({ accountId, workspaceId: workspace.id }, (tx) => tx<{ tag_id: string }[]>`SELECT tag_id FROM bookmark_tags`);

    expect(await read(a)).toEqual([{ tag_id: tagOfA }]);
    expect(await read(b)).toEqual([]);
    expect(await appAs({ accountId: a }, (tx) => tx<{ tag_id: string }[]>`SELECT tag_id FROM bookmark_tags`)).toEqual([]);
  });

  it("deletes a tag with its links and keeps the bookmarks, and deleting a bookmark deletes its links and keeps the tags", async () => {
    const workspace = await workspaceOf(1);
    const owner = memberOf(workspace, 0);
    const doomed = await seedTag(workspace.id, owner, "Doomed");
    const kept = await seedTag(workspace.id, owner, "Kept");
    const bookmark = await seedBookmark(workspace.id, owner);
    const other = await seedBookmark(workspace.id, owner);
    await link(workspace.id, bookmark, doomed);
    await link(workspace.id, bookmark, kept);
    await link(workspace.id, other, kept);

    const deleted = await inTenant({ accountId: owner, workspaceId: workspace.id }, (tx) => tagRepository(tx).remove({ tagId: doomed, ownerId: owner }));
    const repeated = await inTenant({ accountId: owner, workspaceId: workspace.id }, (tx) => tagRepository(tx).remove({ tagId: doomed, ownerId: owner }));

    expect({ deleted, repeated }).toEqual({ deleted: true, repeated: false });
    expect((await storedTags(workspace.id)).map((tag) => tag.name)).toEqual(["Kept"]);
    expect(await storedLinks(workspace.id)).toBe(2);
    const bookmarks = await asSystem(db, (tx) => tx<{ n: string }[]>`SELECT count(*)::text AS n FROM bookmarks WHERE workspace_id = ${workspace.id}`);
    expect(bookmarks[0]?.n).toBe("2");

    await asSystem(db, (tx) => tx`DELETE FROM bookmarks WHERE id = ${bookmark}`);
    expect(await storedLinks(workspace.id)).toBe(1);
    expect((await storedTags(workspace.id)).map((tag) => tag.name)).toEqual(["Kept"]);
  });

  it("leaves with the membership that owns it: removing a member deletes their tags and links and no one else's", async () => {
    const workspace = await workspaceOf(3);
    const [owner, leaving, staying] = [memberOf(workspace, 0), memberOf(workspace, 1), memberOf(workspace, 2)];
    const theirs = await seedTag(workspace.id, leaving, "Theirs");
    await seedTag(workspace.id, staying, "Stays");
    const bookmark = await seedBookmark(workspace.id, owner);
    await link(workspace.id, bookmark, theirs);

    const removed = await inTenant({ accountId: owner, workspaceId: workspace.id }, (tx) => memberRepository(tx).remove(leaving, []));

    expect(removed).toBe(true);
    expect((await storedTags(workspace.id)).map((tag) => tag.name)).toEqual(["Stays"]);
    expect(await storedLinks(workspace.id)).toBe(0);
  });
});

describe("merging tags", () => {
  async function linksByTag(workspaceId: string): Promise<Record<string, number>> {
    const rows = await asSystem(
      db,
      (tx) => tx<{ name: string; n: string }[]>`
        SELECT t.name, count(l.bookmark_id)::text AS n FROM tags t LEFT JOIN bookmark_tags l ON l.tag_id = t.id WHERE t.workspace_id = ${workspaceId} GROUP BY t.name ORDER BY t.name`,
    );
    return Object.fromEntries(rows.map((row) => [row.name, Number(row.n)]));
  }

  it("copies the links of the source to the target once, deletes the source with its links, counts the target without the archived bookmarks and leaves other tags alone", async () => {
    const workspace = await workspaceOf(2);
    const [owner, other] = [memberOf(workspace, 0), memberOf(workspace, 1)];
    const [source, target, bystander, theirs] = [
      await seedTag(workspace.id, owner, "Source"),
      await seedTag(workspace.id, owner, "Target"),
      await seedTag(workspace.id, owner, "Bystander"),
      await seedTag(workspace.id, other, "Source"),
    ];
    const both = await seedBookmark(workspace.id, owner);
    await link(workspace.id, both, source);
    await link(workspace.id, both, target);
    await link(workspace.id, both, bystander);
    await link(workspace.id, await seedBookmark(workspace.id, owner), source);
    await link(workspace.id, await seedBookmark(workspace.id, owner, true), source);
    await link(workspace.id, await seedBookmark(workspace.id, owner), target);
    await link(workspace.id, await seedBookmark(workspace.id, other), theirs);

    const outcome = await inTenant({ accountId: owner, workspaceId: workspace.id }, (tx) => tagRepository(tx).merge({ sourceId: source, targetId: target, ownerId: owner }));

    expect(outcome).toEqual({ kind: "merged", tag: { id: target, name: "Target", bookmarkCount: 3, createdAt: expect.any(Date) as Date } });
    expect((await storedTags(workspace.id)).map((tag) => [tag.name, tag.owner_id])).toEqual([["Bystander", owner], ["Source", other], ["Target", owner]]);
    expect(await linksByTag(workspace.id)).toEqual({ Bystander: 1, Source: 1, Target: 4 });
  });

  it("answers not_found for a tag that is another member's, another workspace's or unknown, as the source and as the target, and same_tag for one tag named twice, writing nothing", async () => {
    const workspace = await workspaceOf(2);
    const elsewhere = await workspaceOf(1);
    const [owner, other] = [memberOf(workspace, 0), memberOf(workspace, 1)];
    const mine = await seedTag(workspace.id, owner, "Mine");
    const theirs = await seedTag(workspace.id, other, "Theirs");
    const foreign = await seedTag(elsewhere.id, memberOf(elsewhere, 0), "Foreign");
    await link(workspace.id, await seedBookmark(workspace.id, owner), mine);
    await link(workspace.id, await seedBookmark(workspace.id, other), theirs);
    await link(elsewhere.id, await seedBookmark(elsewhere.id, memberOf(elsewhere, 0)), foreign);
    const merge = (sourceId: string, targetId: string) => inTenant({ accountId: owner, workspaceId: workspace.id }, (tx) => tagRepository(tx).merge({ sourceId, targetId, ownerId: owner }));
    const unknown = freshId();

    const outcomes = [await merge(mine, theirs), await merge(mine, foreign), await merge(mine, unknown), await merge(theirs, mine), await merge(foreign, mine), await merge(unknown, mine), await merge(theirs, theirs), await merge(unknown, unknown)];
    const same = await merge(mine, mine);

    expect(outcomes.map((outcome) => outcome.kind)).toEqual(Array<string>(8).fill("not_found"));
    expect(same.kind).toBe("same_tag");
    expect(await linksByTag(workspace.id)).toEqual({ Mine: 1, Theirs: 1 });
    expect(await linksByTag(elsewhere.id)).toEqual({ Foreign: 1 });
  });

  it("refuses to act for an account other than the one of the transaction", async () => {
    const workspace = await workspaceOf(2);
    const [owner, other] = [memberOf(workspace, 0), memberOf(workspace, 1)];
    const [source, target] = [await seedTag(workspace.id, owner, "Source"), await seedTag(workspace.id, owner, "Target")];

    await expect(inTenant({ accountId: other, workspaceId: workspace.id }, (tx) => tagRepository(tx).merge({ sourceId: source, targetId: target, ownerId: owner }))).rejects.toThrow(
      "for the account of the transaction only",
    );
    expect((await storedTags(workspace.id)).map((tag) => tag.name)).toEqual(["Source", "Target"]);
  });

  it("changes nothing when the copy of a link is refused part-way: the source and its links stay and the target gains none", async () => {
    const workspace = await workspaceOf(2);
    const [owner, other] = [memberOf(workspace, 0), memberOf(workspace, 1)];
    const [source, target] = [await seedTag(workspace.id, owner, "Source"), await seedTag(workspace.id, owner, "Target")];
    await link(workspace.id, await seedBookmark(workspace.id, owner), source);
    // A link of the owner's tag to a bookmark another member owns, which no request can make: the policy of the links admits no copy of it.
    await link(workspace.id, await seedBookmark(workspace.id, other), source);

    const code = await refusedWith(inTenant({ accountId: owner, workspaceId: workspace.id }, (tx) => tagRepository(tx).merge({ sourceId: source, targetId: target, ownerId: owner })));

    expect(code).toBe(INSUFFICIENT_PRIVILEGE);
    expect((await storedTags(workspace.id)).map((tag) => tag.name)).toEqual(["Source", "Target"]);
    expect(await linksByTag(workspace.id)).toEqual({ Source: 2, Target: 0 });
  });

  it("waits for a transaction that is tagging with the source and carries the link it adds, instead of deleting the tag under it", async () => {
    const workspace = await workspaceOf(1);
    const owner = memberOf(workspace, 0);
    const [source, target] = [await seedTag(workspace.id, owner, "Source"), await seedTag(workspace.id, owner, "Target")];
    const bookmark = await seedBookmark(workspace.id, owner);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    const tagging = new Promise<void>((resolve) => {
      locked = resolve;
    });

    const tagger = inTenant({ accountId: owner, workspaceId: workspace.id }, async (tx) => {
      expect(await lockTaggingTags(tx, owner, { ids: [source], names: [] })).toBe(true);
      locked();
      await held;
      return insertTagLinks(tx, bookmark, [source]);
    });
    await tagging;
    let merged = false;
    const merger = inTenant({ accountId: owner, workspaceId: workspace.id }, (tx) => tagRepository(tx).merge({ sourceId: source, targetId: target, ownerId: owner })).then((outcome) => {
      merged = true;
      return outcome;
    });
    await sleep(300);
    expect(merged).toBe(false);
    release();

    expect(await tagger).toBe(1);
    expect(await merger).toMatchObject({ kind: "merged", tag: { id: target, bookmarkCount: 1 } });
    expect(await linksByTag(workspace.id)).toEqual({ Target: 1 });
  });

  it("lets one of two merges of a pair in opposite directions through and finds the other's tag gone", async () => {
    const workspace = await workspaceOf(1);
    const owner = memberOf(workspace, 0);
    const [left, right] = [await seedTag(workspace.id, owner, "Left"), await seedTag(workspace.id, owner, "Right")];
    await link(workspace.id, await seedBookmark(workspace.id, owner), left);
    await link(workspace.id, await seedBookmark(workspace.id, owner), right);
    const merge = (sourceId: string, targetId: string) => inTenant({ accountId: owner, workspaceId: workspace.id }, (tx) => tagRepository(tx).merge({ sourceId, targetId, ownerId: owner }));

    const outcomes = await Promise.all([merge(left, right), merge(right, left)]);

    expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(["merged", "not_found"]);
    expect(Object.values(await linksByTag(workspace.id))).toEqual([2]);
  });
});

describe("deleting an account", () => {
  it("deletes the tags and the links of the account with it and keeps the tags of the members who stay", async () => {
    const workspace = await workspaceOf(2);
    const [stays, leaves] = [memberOf(workspace, 0), memberOf(workspace, 1)];
    const theirs = await seedTag(workspace.id, leaves, "Theirs");
    await seedTag(workspace.id, stays, "Stays");
    await link(workspace.id, await seedBookmark(workspace.id, stays), theirs);

    const deleted = await inTenant({ accountId: leaves }, (tx) => accountDeletionRepository(tx).delete([], []));

    expect(deleted).toBe(true);
    expect((await storedTags(workspace.id)).map((tag) => tag.name)).toEqual(["Stays"]);
    expect(await storedLinks(workspace.id)).toBe(0);
  });
});

describe("deleting a workspace", () => {
  it("lists the links and the tags before the bookmarks and the members in the purge order, and the purge function deletes them in batches", async () => {
    const order = (table: string) => workspacePurgeOrder.indexOf(table);
    expect(order("bookmark_tags")).toBeGreaterThanOrEqual(0);
    expect(order("bookmark_tags")).toBeLessThan(order("bookmarks"));
    expect(order("bookmark_tags")).toBeLessThan(order("tags"));
    expect(order("tags")).toBeGreaterThanOrEqual(0);
    expect(order("tags")).toBeLessThan(order("workspace_members"));

    const doomed = await workspaceOf(2);
    const kept = await workspaceOf(1);
    const bookmark = await seedBookmark(doomed.id, memberOf(doomed, 0));
    for (let index = 0; index < 5; index += 1) {
      const tag = await seedTag(doomed.id, memberOf(doomed, index % 2), `Doomed ${String(index)}`);
      await link(doomed.id, bookmark, tag);
    }
    await seedTag(kept.id, memberOf(kept, 0), "Kept");
    const purge = (workspaceId: string, table: string) =>
      db.app<{ n: number }[]>`SELECT sys_workspace_purge_batch(${workspaceId}::uuid, ${table}, 2) AS n`.then((rows) => rows[0]?.n);

    expect(await purge(doomed.id, "tags")).toBe(0);
    expect(await storedTags(doomed.id)).toHaveLength(5);

    await asSystem(db, (tx) => tx`UPDATE workspaces SET deleting_at = now() WHERE id = ${doomed.id}`);
    expect([await purge(doomed.id, "bookmark_tags"), await purge(doomed.id, "bookmark_tags"), await purge(doomed.id, "bookmark_tags"), await purge(doomed.id, "bookmark_tags")]).toEqual([2, 2, 1, 0]);
    expect([await purge(doomed.id, "tags"), await purge(doomed.id, "tags"), await purge(doomed.id, "tags")]).toEqual([2, 2, 1]);
    expect(await storedTags(doomed.id)).toHaveLength(0);
    expect(await storedTags(kept.id)).toHaveLength(1);
  });

  it("leaves no tag of a workspace behind when the workspace row is deleted", async () => {
    const workspace = await workspaceOf(1);
    const owner = memberOf(workspace, 0);
    const tag = await seedTag(workspace.id, owner, "Gone with it");
    await link(workspace.id, await seedBookmark(workspace.id, owner), tag);

    await asSystem(db, async (tx) => {
      await tx`UPDATE workspaces SET deleting_at = now() WHERE id = ${workspace.id}`;
      await tx`SELECT public.sys_workspace_delete_finish(${workspace.id}::uuid)`;
    });

    expect(await storedTags(workspace.id)).toEqual([]);
    expect(await storedLinks(workspace.id)).toBe(0);
  });
});

describe("the scoped repository of the registry", () => {
  it("registers all four methods of tags, so the cross-tenant matrix runs each of them", () => {
    expect(
      listRepositoryMethods()
        .filter((entry) => entry.repository === "tags")
        .map((entry) => [entry.method, entry.table])
        .sort(),
    ).toEqual([["delete", "tags"], ["insert", "tags"], ["select", "tags"], ["update", "tags"]]);
  });

  it("refuses a column outside the grant before the database is asked", async () => {
    const workspace = await workspaceOf(1);
    const owner = memberOf(workspace, 0);
    const id = await seedTag(workspace.id, owner, "Fixed");
    const update = listRepositoryMethods().find((entry) => entry.repository === "tags" && entry.method === "update");

    await expect(
      inTenant({ accountId: owner, workspaceId: workspace.id }, (tx) => (update?.invoke(tx, { set: { ownerId: freshId() }, where: eq(tags.id, id) }) ?? Promise.resolve([]))),
    ).rejects.toThrow("not one the repository updates");
  });
});
