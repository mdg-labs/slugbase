import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TenantContextError, urlMetadataRepository, type UrlMetadataResult } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// The cache of page metadata and the table behind it (doc 05 section 2.7, doc 02 section 5.4, doc 10 section 5 and T1). The failure scenario: two
// workspaces save the same URL. The cache is per workspace, so a member of A reads no result that B's fetch stored, a result stored for A replaces
// nothing of B's (the same primary key apart from the workspace), and with the application's predicates left out row-level security still shows A
// nothing of B's, refuses a row written for B and changes none of B's.

const HOOK_TIMEOUT_MS = 300_000;
const ROW_LEVEL_SECURITY = "42501";
const INSUFFICIENT_PRIVILEGE = "42501";
const CHECK_VIOLATION = "23514";
const URL_OF_PAGE = "https://example.com/article";

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
  await seedAccount(db, { id, email: `url-metadata${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub", emailVerified: true });
  return id;
}

interface Workspace {
  readonly id: string;
  readonly owner: string;
}

async function workspaceOf(): Promise<Workspace> {
  const id = await seedWorkspace(db, { name: "Metadata test" });
  const owner = await account();
  await seedMember(db, { workspaceId: id, accountId: owner, role: "owner" });
  return { id, owner };
}

function inTenant<T>(workspace: Workspace, work: Parameters<typeof db.tenant.withTenant<T>>[1]): Promise<T> {
  return db.tenant.withTenant({ accountId: workspace.owner, workspaceId: workspace.id, requestId: "url-metadata-test" }, work);
}

/** Runs `work` as slugbase_app with the settings of withTenant and nothing else: no repository, no application layer. */
async function appAs<T>(workspace: Workspace, work: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  const result = await db.app.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${workspace.owner}, true), set_config('app.workspace_id', ${workspace.id}, true)`;
    return { value: await work(tx) };
  });
  return result.value;
}

const OK: UrlMetadataResult = { status: "ok", title: "Title", description: "Description", siteName: "Site", canonicalUrl: "https://example.com/canonical", language: "en" };

interface Row {
  readonly workspace_id: string;
  readonly url_canonical: string;
  readonly status: string;
  readonly title: string | null;
  readonly description: string | null;
  readonly site_name: string | null;
  readonly canonical_url: string | null;
  readonly language: string | null;
  readonly fetched_at: Date;
  readonly expires_at: Date;
}

function rowsOf(workspaceId: string): Promise<Row[]> {
  return asSystem(db, (tx) => tx<Row[]>`SELECT * FROM url_metadata WHERE workspace_id = ${workspaceId} ORDER BY url_canonical`).then((rows) => [...rows]);
}

beforeEach(async () => {
  await asSystem(db, (tx) => tx`DELETE FROM url_metadata`);
});

describe("a result for a workspace and a canonical URL", () => {
  it("is stored and read back for that workspace, with the fields of an ok result and the dates of the database clock", async () => {
    const a = await workspaceOf();

    await inTenant(a, (tx) => urlMetadataRepository(tx).store(URL_OF_PAGE, OK));

    const [row] = await rowsOf(a.id);
    expect(row).toMatchObject({ url_canonical: URL_OF_PAGE, status: "ok", title: "Title", description: "Description", site_name: "Site", canonical_url: "https://example.com/canonical", language: "en" });
    expect(row?.expires_at.getTime()).toBe((row?.fetched_at.getTime() ?? 0) + 7 * 24 * 3600 * 1000);
    const current = await inTenant(a, (tx) => urlMetadataRepository(tx).current(URL_OF_PAGE));
    expect(current).toMatchObject({ urlCanonical: URL_OF_PAGE, status: "ok", title: "Title", siteName: "Site", canonicalUrl: "https://example.com/canonical", language: "en" });
  });

  it("is replaced by a later one for the same URL, which clears the fields of a result that is not ok", async () => {
    const a = await workspaceOf();
    await inTenant(a, (tx) => urlMetadataRepository(tx).store(URL_OF_PAGE, OK));

    await inTenant(a, (tx) => urlMetadataRepository(tx).store(URL_OF_PAGE, { status: "blocked" }));

    expect(await rowsOf(a.id)).toMatchObject([{ status: "blocked", title: null, description: null, site_name: null, canonical_url: null, language: null }]);
  });

  it("is current until the database clock passes expires_at", async () => {
    const a = await workspaceOf();
    await inTenant(a, (tx) => urlMetadataRepository(tx).store(URL_OF_PAGE, OK));
    expect(await inTenant(a, (tx) => urlMetadataRepository(tx).current(URL_OF_PAGE))).toBeDefined();

    await asSystem(db, (tx) => tx`UPDATE url_metadata SET fetched_at = now() - interval '8 days', expires_at = now() - interval '1 day' WHERE workspace_id = ${a.id}`);

    expect(await inTenant(a, (tx) => urlMetadataRepository(tx).current(URL_OF_PAGE))).toBeUndefined();
    await inTenant(a, (tx) => urlMetadataRepository(tx).store(URL_OF_PAGE, { status: "failed" }));
    expect(await inTenant(a, (tx) => urlMetadataRepository(tx).current(URL_OF_PAGE))).toMatchObject({ status: "failed" });
  });

  it("is refused by the repository outside a tenant transaction with a workspace", async () => {
    const a = await workspaceOf();

    await expect(db.tenant.withTenant({ accountId: a.owner, requestId: "url-metadata-test" }, (tx) => urlMetadataRepository(tx).store(URL_OF_PAGE, OK))).rejects.toBeInstanceOf(TenantContextError);
    await expect(db.tenant.withTenant({ accountId: a.owner, requestId: "url-metadata-test" }, (tx) => urlMetadataRepository(tx).current(URL_OF_PAGE))).rejects.toBeInstanceOf(TenantContextError);
  });
});

describe("two workspaces that save the same URL", () => {
  it("do not see each other's results, and a result stored for one replaces nothing of the other's", async () => {
    const a = await workspaceOf();
    const b = await workspaceOf();
    await inTenant(b, (tx) => urlMetadataRepository(tx).store(URL_OF_PAGE, { ...OK, title: "Title of B" }));

    expect(await inTenant(a, (tx) => urlMetadataRepository(tx).current(URL_OF_PAGE))).toBeUndefined();

    await inTenant(a, (tx) => urlMetadataRepository(tx).store(URL_OF_PAGE, { ...OK, title: "Title of A" }));
    await inTenant(a, (tx) => urlMetadataRepository(tx).store(URL_OF_PAGE, { status: "failed" }));

    expect(await rowsOf(b.id)).toMatchObject([{ status: "ok", title: "Title of B" }]);
    expect(await inTenant(b, (tx) => urlMetadataRepository(tx).current(URL_OF_PAGE))).toMatchObject({ title: "Title of B" });
    expect(await inTenant(a, (tx) => urlMetadataRepository(tx).current(URL_OF_PAGE))).toMatchObject({ status: "failed" });
  });

  it("are kept apart by row-level security alone: a read shows nothing of B, a write naming B is refused, and an update touches none of B's rows", async () => {
    const a = await workspaceOf();
    const b = await workspaceOf();
    await inTenant(b, (tx) => urlMetadataRepository(tx).store(URL_OF_PAGE, { ...OK, title: "Title of B" }));
    const before = await rowsOf(b.id);

    expect(await appAs(a, (tx) => tx`SELECT * FROM url_metadata`)).toHaveLength(0);
    await expect(
      appAs(a, (tx) => tx`INSERT INTO url_metadata (workspace_id, url_canonical, status, fetched_at, expires_at) VALUES (${b.id}, 'https://example.com/planted', 'failed', now(), now() + interval '7 days')`),
    ).rejects.toMatchObject({ code: ROW_LEVEL_SECURITY });
    expect(await appAs(a, (tx) => tx`UPDATE url_metadata SET title = 'overwritten' RETURNING workspace_id`)).toHaveLength(0);
    await expect(
      appAs(a, (tx) => tx`INSERT INTO url_metadata (workspace_id, url_canonical, status, fetched_at, expires_at) VALUES (${b.id}, ${URL_OF_PAGE}, 'failed', now(), now()) ON CONFLICT (workspace_id, url_canonical) DO UPDATE SET status = 'failed'`),
    ).rejects.toMatchObject({ code: ROW_LEVEL_SECURITY });

    expect(await rowsOf(b.id)).toEqual(before);
  });
});

describe("the privileges and checks of the table", () => {
  it("lets slugbase_app read, insert and update the columns of a result, and delete or move nothing", async () => {
    const a = await workspaceOf();
    await inTenant(a, (tx) => urlMetadataRepository(tx).store(URL_OF_PAGE, OK));

    await expect(appAs(a, (tx) => tx`DELETE FROM url_metadata`)).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    await expect(appAs(a, (tx) => tx`UPDATE url_metadata SET url_canonical = 'https://example.com/moved'`)).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    await expect(appAs(a, (tx) => tx`UPDATE url_metadata SET workspace_id = ${freshId()}`)).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    expect(await appAs(a, (tx) => tx`UPDATE url_metadata SET title = 'changed' RETURNING title`)).toHaveLength(1);
  });

  it.each([
    ["a status outside ok, failed and blocked", `'stale', NULL, NULL, NULL`],
    ["a title over 300 characters", `'ok', repeat('t', 301), NULL, NULL`],
    ["a description over 1000 characters", `'ok', NULL, repeat('d', 1001), NULL`],
    ["a site name over 100 characters", `'ok', NULL, NULL, repeat('s', 101)`],
    ["fields on a result that is failed", `'failed', 'Title', NULL, NULL`],
    ["fields on a result that is blocked", `'blocked', NULL, NULL, 'Site'`],
  ])("refuses %s", async (_name, columns) => {
    const a = await workspaceOf();

    await expect(
      appAs(a, (tx) =>
        tx.unsafe(
          `INSERT INTO url_metadata (workspace_id, url_canonical, status, title, description, site_name, fetched_at, expires_at)
           SELECT '${a.id}', 'https://example.com/check', v.*, now(), now() + interval '7 days' FROM (SELECT ${columns}) AS v`,
        ),
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  it("refuses a canonical link or a language over its limit, and a URL over 2048 characters", async () => {
    const a = await workspaceOf();
    const insert = (url: string, canonical: string, language: string) =>
      appAs(a, (tx) =>
        tx`INSERT INTO url_metadata (workspace_id, url_canonical, status, canonical_url, language, fetched_at, expires_at) VALUES (${a.id}, ${url}, 'ok', ${canonical}, ${language}, now(), now())`,
      );

    await expect(insert("https://example.com/a", "https://example.com/" + "c".repeat(2030), "en")).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(insert("https://example.com/b", "https://example.com/c", "l".repeat(36))).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(insert("https://example.com/" + "u".repeat(2030), "https://example.com/c", "en")).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });
});

describe("the canonical URL of a bookmark", () => {
  async function seedBookmark(workspace: Workspace, options: { readonly canonical: string; readonly archived?: boolean }): Promise<string> {
    const id = freshId();
    await asSystem(
      db,
      (tx) => tx`
        INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, plan_archived_at)
        VALUES (${id}, ${workspace.id}, ${workspace.owner}, ${`${options.canonical}#fragment`}, ${options.canonical}, 'example.com', 'Seed', ${options.archived === true ? new Date() : null})`,
    );
    return id;
  }

  it("is read for a bookmark of the workspace and never for an archived one, another workspace's or an unknown one", async () => {
    const a = await workspaceOf();
    const b = await workspaceOf();
    const own = await seedBookmark(a, { canonical: URL_OF_PAGE });
    const archived = await seedBookmark(a, { canonical: "https://example.com/archived", archived: true });
    const foreign = await seedBookmark(b, { canonical: "https://example.com/of-b" });

    const read = (id: string) => inTenant(a, (tx) => urlMetadataRepository(tx).bookmarkUrl(id));

    expect(await read(own)).toBe(URL_OF_PAGE);
    expect(await read(archived)).toBeUndefined();
    expect(await read(foreign)).toBeUndefined();
    expect(await read(freshId())).toBeUndefined();
  });

  it("is read without changing the bookmark", async () => {
    const a = await workspaceOf();
    const id = await seedBookmark(a, { canonical: URL_OF_PAGE });
    const snapshot = () => asSystem(db, (tx) => tx`SELECT b::text AS row FROM bookmarks b WHERE id = ${id}`);
    const before = await snapshot();

    await inTenant(a, async (tx) => {
      const repository = urlMetadataRepository(tx);
      await repository.bookmarkUrl(id);
      await repository.store(URL_OF_PAGE, OK);
    });

    expect(await snapshot()).toEqual(before);
  });
});
