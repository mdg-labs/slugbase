import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importRepository } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// The reads of the import preview (doc 02 section 13.1, doc 01 section 7.5, doc 10 T1). The failure scenario: a duplicate found among another member's bookmarks, a plan-archived bookmark, a bookmark with no
// owner or another workspace's, and a room under the limit worked out from the rows and not from the counter of the workspace's row.

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
  await seedAccount(db, { id, email: `import${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub", emailVerified: true });
  return id;
}

async function workspace(members: readonly string[]): Promise<string> {
  const id = await seedWorkspace(db, { name: "Import test" });
  for (const accountId of members) {
    await seedMember(db, { workspaceId: id, accountId, role: "member" });
  }
  return id;
}

async function bookmark(workspaceId: string, ownerId: string | null, canonical: string, archived = false): Promise<void> {
  await asSystem(
    db,
    (tx) => tx`
      INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, plan_archived_at)
      VALUES (${freshId()}, ${workspaceId}, ${ownerId}, ${canonical}, ${canonical}, 'example.com', 'Title', ${archived ? new Date() : null})`,
  );
}

function asMember<T>(workspaceId: string, accountId: string, work: Parameters<typeof db.tenant.withTenant<T>>[1]): Promise<T> {
  return db.tenant.withTenant({ accountId, workspaceId, requestId: "import-test" }, work);
}

describe("the existing canonical URLs of the import preview", () => {
  it("are the member's own on bookmarks that are not plan-archived, each once, and nothing of another member's, of no owner's or of another workspace's", async () => {
    const me = await account();
    const other = await account();
    const w = await workspace([me, other]);
    const elsewhere = await workspace([me]);
    await bookmark(w, me, "https://example.com/mine");
    await bookmark(w, me, "https://example.com/mine");
    await bookmark(w, me, "https://example.com/archived", true);
    await bookmark(w, other, "https://example.com/members");
    await bookmark(w, null, "https://example.com/ownerless");
    await bookmark(elsewhere, me, "https://example.com/other-workspace");
    const asked = ["https://example.com/mine", "https://example.com/archived", "https://example.com/members", "https://example.com/ownerless", "https://example.com/other-workspace", "https://example.com/unknown"];

    const found = await asMember(w, me, (tx) => importRepository(tx).existingCanonicalUrls(asked));
    const foundByOther = await asMember(w, other, (tx) => importRepository(tx).existingCanonicalUrls(asked));

    expect([...found]).toEqual(["https://example.com/mine"]);
    expect([...foundByOther]).toEqual(["https://example.com/members"]);
  });

  it("answer a whole file of canonical URLs, and nothing for none", async () => {
    const me = await account();
    const w = await workspace([me]);
    for (let n = 0; n < 50; n += 1) {
      await bookmark(w, me, `https://example.com/${String(n)}`);
    }
    const asked = Array.from({ length: 5000 }, (_, n) => `https://example.com/${String(n)}`);

    const found = await asMember(w, me, (tx) => importRepository(tx).existingCanonicalUrls(asked));
    const none = await asMember(w, me, (tx) => importRepository(tx).existingCanonicalUrls([]));

    expect(found.size).toBe(50);
    expect(none.size).toBe(0);
  });

  it("match a URL as text, whatever characters it holds", async () => {
    const me = await account();
    const w = await workspace([me]);
    const odd = "https://example.com/a'b\"c\\d%e_f,g)h";
    await bookmark(w, me, odd);

    expect([...(await asMember(w, me, (tx) => importRepository(tx).existingCanonicalUrls([odd, "https://example.com/a'b' OR '1'='1"])))]).toEqual([odd]);
  });

  it("need a transaction opened with a workspace", async () => {
    const me = await account();
    await expect(db.tenant.withTenant({ accountId: me, requestId: "import-test" }, (tx) => importRepository(tx).existingCanonicalUrls(["https://example.com/"]))).rejects.toThrow(/workspace/);
    await expect(db.tenant.withTenant({ accountId: me, requestId: "import-test" }, (tx) => importRepository(tx).bookmarkCount())).rejects.toThrow(/workspace/);
  });
});

describe("the bookmark counter of the import preview", () => {
  it("is the counter of the workspace's row and not a count of its bookmarks", async () => {
    const me = await account();
    const w = await workspace([me]);
    await bookmark(w, me, "https://example.com/a");
    await bookmark(w, me, "https://example.com/b");
    await bookmark(w, me, "https://example.com/c", true);
    await asSystem(db, (tx) => tx`UPDATE workspaces SET bookmark_count = 7 WHERE id = ${w}`);

    expect(await asMember(w, me, (tx) => importRepository(tx).bookmarkCount())).toBe(7);
  });

  it("is undefined for a workspace the account is no member of", async () => {
    const me = await account();
    const stranger = await account();
    const w = await workspace([me]);

    expect(await asMember(w, stranger, (tx) => importRepository(tx).bookmarkCount())).toBeUndefined();
    expect(await asMember(w, me, (tx) => importRepository(tx).bookmarkCount())).toBe(0);
  });
});
