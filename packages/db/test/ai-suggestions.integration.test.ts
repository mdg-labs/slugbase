import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { aiSuggestionRepository, TenantContextError, type StoredAiSuggestion } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// The cache of AI suggestions, the count of accepted fields and the tables behind them (doc 05 section 2.8, doc 02 section 14, doc 10 T1 and T11). The failure
// scenario: a suggestion is built from one member's tag names, so the cache of workspace A is never served to workspace B, and the cache of one member is
// never served to another member of the same workspace, for the same URL and language. With the application's predicates left out row-level security still
// shows a member nothing of the others', refuses a row written for another member or workspace and changes none of theirs.

const HOOK_TIMEOUT_MS = 300_000;
const ROW_LEVEL_SECURITY = "42501";
const INSUFFICIENT_PRIVILEGE = "42501";
const CHECK_VIOLATION = "23514";
const URL_OF_PAGE = "https://example.com/article";
const SUGGESTION: StoredAiSuggestion = { title: "The article", slug: "article", tags: ["reading"], confidence: 0.8 };

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
  await seedAccount(db, { id, email: `ai-suggestions${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub", emailVerified: true });
  return id;
}

interface Member {
  readonly workspaceId: string;
  readonly accountId: string;
}

/** A workspace with two members, `first` and `second`. */
async function workspaceOf(): Promise<{ readonly first: Member; readonly second: Member }> {
  const workspaceId = await seedWorkspace(db, { name: "AI suggestions test" });
  const first = await account();
  const second = await account();
  await seedMember(db, { workspaceId, accountId: first, role: "owner" });
  await seedMember(db, { workspaceId, accountId: second, role: "member" });
  return { first: { workspaceId, accountId: first }, second: { workspaceId, accountId: second } };
}

function inTenant<T>(member: Member, work: Parameters<typeof db.tenant.withTenant<T>>[1]): Promise<T> {
  return db.tenant.withTenant({ accountId: member.accountId, workspaceId: member.workspaceId, requestId: "ai-suggestions-test" }, work);
}

/** Runs `work` as slugbase_app with the settings of withTenant and nothing else: no repository, no application layer. */
async function appAs<T>(member: Member, work: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  const result = await db.app.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${member.accountId}, true), set_config('app.workspace_id', ${member.workspaceId}, true)`;
    return { value: await work(tx) };
  });
  return result.value;
}

const store = (member: Member, title: string, locale = "en") =>
  inTenant(member, (tx) => aiSuggestionRepository(tx).store({ urlCanonical: URL_OF_PAGE, locale, result: { ...SUGGESTION, title }, provider: "Example AI", model: "model-1" }));

const current = (member: Member, locale = "en") => inTenant(member, (tx) => aiSuggestionRepository(tx).current(URL_OF_PAGE, locale));

interface Row {
  readonly workspace_id: string;
  readonly account_id: string;
  readonly url_canonical: string;
  readonly locale: string;
  readonly result: StoredAiSuggestion;
  readonly provider: string;
  readonly model: string;
  readonly created_at: Date;
  readonly expires_at: Date;
}

const rowsOf = (workspaceId: string) =>
  asSystem(db, (tx) => tx<Row[]>`SELECT * FROM ai_suggestions WHERE workspace_id = ${workspaceId} ORDER BY account_id, locale`).then((rows) => [...rows]);

interface UsageRow {
  readonly account_id: string;
  readonly bookmark_id: string | null;
  readonly fields_used: string[];
}

const usageOf = (workspaceId: string) =>
  asSystem(db, (tx) => tx<UsageRow[]>`SELECT account_id, bookmark_id, fields_used FROM ai_suggestion_usage WHERE workspace_id = ${workspaceId} ORDER BY created_at, id`).then((rows) => [...rows]);

beforeEach(async () => {
  await asSystem(db, (tx) => tx`DELETE FROM ai_suggestions`);
  await asSystem(db, (tx) => tx`DELETE FROM ai_suggestion_usage`);
});

describe("a suggestion for a member, a workspace, a canonical URL and a language", () => {
  it("is stored and read back, with what answered and the dates of the database clock, 30 days apart", async () => {
    const { first } = await workspaceOf();

    await store(first, "The article");

    const [row] = await rowsOf(first.workspaceId);
    expect(row).toMatchObject({ account_id: first.accountId, url_canonical: URL_OF_PAGE, locale: "en", result: { ...SUGGESTION, title: "The article" }, provider: "Example AI", model: "model-1" });
    expect(row?.expires_at.getTime()).toBe((row?.created_at.getTime() ?? 0) + 30 * 24 * 3600 * 1000);
    expect(await current(first)).toEqual({ result: { ...SUGGESTION, title: "The article" }, provider: "Example AI", model: "model-1" });
  });

  it("is replaced by a later one for the same key, and a language is a key of its own", async () => {
    const { first } = await workspaceOf();
    await store(first, "First");
    await store(first, "Second");
    await store(first, "Auf Deutsch", "de");

    expect(await current(first)).toMatchObject({ result: { title: "Second" } });
    expect(await current(first, "de")).toMatchObject({ result: { title: "Auf Deutsch" } });
    expect(await rowsOf(first.workspaceId)).toHaveLength(2);
  });

  it("is current until the database clock passes expires_at, and then replaced", async () => {
    const { first } = await workspaceOf();
    await store(first, "First");
    expect(await current(first)).toBeDefined();

    await asSystem(db, (tx) => tx`UPDATE ai_suggestions SET created_at = now() - interval '31 days', expires_at = now() - interval '1 day' WHERE workspace_id = ${first.workspaceId}`);

    expect(await current(first)).toBeUndefined();
    await store(first, "Again");
    expect(await current(first)).toMatchObject({ result: { title: "Again" } });
  });

  it("is refused by the repository outside a tenant transaction with a workspace", async () => {
    const { first } = await workspaceOf();

    await expect(db.tenant.withTenant({ accountId: first.accountId, requestId: "ai-suggestions-test" }, (tx) => aiSuggestionRepository(tx).current(URL_OF_PAGE, "en"))).rejects.toBeInstanceOf(TenantContextError);
    await expect(
      db.tenant.withTenant({ accountId: first.accountId, requestId: "ai-suggestions-test" }, (tx) =>
        aiSuggestionRepository(tx).store({ urlCanonical: URL_OF_PAGE, locale: "en", result: SUGGESTION, provider: "p", model: "m" }),
      ),
    ).rejects.toBeInstanceOf(TenantContextError);
    await expect(
      db.tenant.withTenant({ accountId: first.accountId, requestId: "ai-suggestions-test" }, (tx) => aiSuggestionRepository(tx).recordUsage({ id: freshId(), bookmarkId: null, fields: ["title"] })),
    ).rejects.toBeInstanceOf(TenantContextError);
  });
});

describe("two members of one workspace who ask for the same URL", () => {
  it("are never served each other's suggestion, and one's replaces nothing of the other's", async () => {
    const { first, second } = await workspaceOf();
    await store(second, "Built from the tags of the second member");

    expect(await current(first)).toBeUndefined();

    await store(first, "Built from the tags of the first member");
    await store(first, "Replaced");

    expect(await current(second)).toMatchObject({ result: { title: "Built from the tags of the second member" } });
    expect(await current(first)).toMatchObject({ result: { title: "Replaced" } });
    expect(await rowsOf(first.workspaceId)).toHaveLength(2);
  });

  it("are kept apart by row-level security alone: a read shows nothing of the other, a write naming the other is refused, and an update touches none of the other's rows", async () => {
    const { first, second } = await workspaceOf();
    await store(second, "Of the second member");
    const before = await rowsOf(first.workspaceId);

    expect(await appAs(first, (tx) => tx`SELECT * FROM ai_suggestions`)).toHaveLength(0);
    await expect(
      appAs(first, (tx) =>
        tx`INSERT INTO ai_suggestions (workspace_id, account_id, url_canonical, locale, result, provider, model, expires_at) VALUES (${first.workspaceId}, ${second.accountId}, 'https://example.com/planted', 'en', '{}', 'p', 'm', now())`,
      ),
    ).rejects.toMatchObject({ code: ROW_LEVEL_SECURITY });
    expect(await appAs(first, (tx) => tx`UPDATE ai_suggestions SET model = 'overwritten' RETURNING account_id`)).toHaveLength(0);
    await expect(
      appAs(first, (tx) =>
        tx`INSERT INTO ai_suggestions (workspace_id, account_id, url_canonical, locale, result, provider, model, expires_at) VALUES (${first.workspaceId}, ${second.accountId}, ${URL_OF_PAGE}, 'en', '{}', 'p', 'm', now()) ON CONFLICT (workspace_id, account_id, url_canonical, locale) DO UPDATE SET model = 'overwritten'`,
      ),
    ).rejects.toMatchObject({ code: ROW_LEVEL_SECURITY });

    expect(await rowsOf(first.workspaceId)).toEqual(before);
  });
});

describe("two workspaces that are asked for the same URL", () => {
  it("never serve each other's suggestion, even for the same account", async () => {
    const a = await workspaceOf();
    const b = await workspaceOf();
    // One account is a member of both workspaces.
    await seedMember(db, { workspaceId: b.first.workspaceId, accountId: a.first.accountId, role: "member" });
    const inA = a.first;
    const inB = { workspaceId: b.first.workspaceId, accountId: a.first.accountId };
    await store(inB, "Of workspace B");

    expect(await current(inA)).toBeUndefined();

    await store(inA, "Of workspace A");
    expect(await current(inB)).toMatchObject({ result: { title: "Of workspace B" } });
    expect(await current(inA)).toMatchObject({ result: { title: "Of workspace A" } });
  });

  it("are kept apart by row-level security alone: a read shows nothing of B, a write naming B is refused", async () => {
    const a = await workspaceOf();
    const b = await workspaceOf();
    await store(b.first, "Of workspace B");
    const before = await rowsOf(b.first.workspaceId);

    expect(await appAs(a.first, (tx) => tx`SELECT * FROM ai_suggestions`)).toHaveLength(0);
    await expect(
      appAs(a.first, (tx) =>
        tx`INSERT INTO ai_suggestions (workspace_id, account_id, url_canonical, locale, result, provider, model, expires_at) VALUES (${b.first.workspaceId}, ${a.first.accountId}, 'https://example.com/planted', 'en', '{}', 'p', 'm', now())`,
      ),
    ).rejects.toMatchObject({ code: ROW_LEVEL_SECURITY });
    expect(await appAs(a.first, (tx) => tx`UPDATE ai_suggestions SET model = 'overwritten' RETURNING account_id`)).toHaveLength(0);

    expect(await rowsOf(b.first.workspaceId)).toEqual(before);
  });
});

describe("the privileges and checks of ai_suggestions", () => {
  it("lets slugbase_app read, insert and update the columns of a result, and delete or move nothing", async () => {
    const { first } = await workspaceOf();
    await store(first, "The article");

    await expect(appAs(first, (tx) => tx`DELETE FROM ai_suggestions`)).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    await expect(appAs(first, (tx) => tx`UPDATE ai_suggestions SET url_canonical = 'https://example.com/moved'`)).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    await expect(appAs(first, (tx) => tx`UPDATE ai_suggestions SET account_id = ${freshId()}`)).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    expect(await appAs(first, (tx) => tx`UPDATE ai_suggestions SET model = 'changed' RETURNING model`)).toHaveLength(1);
  });

  it.each([
    ["a result that is not an object", `'[]'::jsonb, 'p', 'm', 'en'`],
    ["an empty provider", `'{}'::jsonb, '', 'm', 'en'`],
    ["a model over 200 characters", `'{}'::jsonb, 'p', repeat('m', 201), 'en'`],
    ["a language of one character", `'{}'::jsonb, 'p', 'm', 'e'`],
    ["a language over 35 characters", `'{}'::jsonb, 'p', 'm', repeat('l', 36)`],
  ])("refuses %s", async (_name, columns) => {
    const { first } = await workspaceOf();

    await expect(
      appAs(first, (tx) =>
        tx.unsafe(
          `INSERT INTO ai_suggestions (workspace_id, account_id, url_canonical, result, provider, model, locale, expires_at)
           SELECT '${first.workspaceId}', '${first.accountId}', 'https://example.com/check', v.*, now() FROM (SELECT ${columns}) AS v(result, provider, model, locale)`,
        ),
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  it("refuses a row for an account that is no member of the workspace", async () => {
    const { first } = await workspaceOf();
    const stranger = await account();

    await expect(
      asSystem(db, (tx) =>
        tx`INSERT INTO ai_suggestions (workspace_id, account_id, url_canonical, locale, result, provider, model, expires_at) VALUES (${first.workspaceId}, ${stranger}, ${URL_OF_PAGE}, 'en', '{}', 'p', 'm', now())`,
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("goes with the member by foreign key: a removed member's rows and the usage rows are gone, and the others' stay", async () => {
    const { first, second } = await workspaceOf();
    await store(first, "Of the first");
    await store(second, "Of the second");
    await inTenant(first, (tx) => aiSuggestionRepository(tx).recordUsage({ id: freshId(), bookmarkId: null, fields: ["title"] }));
    await inTenant(second, (tx) => aiSuggestionRepository(tx).recordUsage({ id: freshId(), bookmarkId: null, fields: ["tags"] }));

    await asSystem(db, (tx) => tx`DELETE FROM workspace_members WHERE workspace_id = ${first.workspaceId} AND account_id = ${second.accountId}`);

    expect((await rowsOf(first.workspaceId)).map((row) => row.account_id)).toEqual([first.accountId]);
    expect((await usageOf(first.workspaceId)).map((row) => row.account_id)).toEqual([first.accountId]);
  });
});

describe("a member who has left the workspace", () => {
  it("is answered false by the cache and by holdMember, which write nothing, and a member who is there is answered true", async () => {
    const { first, second } = await workspaceOf();
    await asSystem(db, (tx) => tx`DELETE FROM workspace_members WHERE workspace_id = ${first.workspaceId} AND account_id = ${second.accountId}`);

    expect(await store(second, "Of the one who left")).toBe(false);
    expect(await inTenant(second, (tx) => aiSuggestionRepository(tx).holdMember())).toBe(false);
    expect(await rowsOf(first.workspaceId)).toEqual([]);

    expect(await store(first, "Of the one who stayed")).toBe(true);
    expect(await inTenant(first, (tx) => aiSuggestionRepository(tx).holdMember())).toBe(true);
  });

  it("is answered false by holdMember when the workspace is gone", async () => {
    const { first } = await workspaceOf();
    await asSystem(db, (tx) => tx`DELETE FROM workspaces WHERE id = ${first.workspaceId}`);

    expect(await inTenant(first, (tx) => aiSuggestionRepository(tx).holdMember())).toBe(false);
  });
});

describe("the count of accepted fields", () => {
  it("is one row for the member and the workspace with the fields and the bookmark and no content", async () => {
    const { first } = await workspaceOf();
    const bookmarkId = freshId();

    await inTenant(first, (tx) => aiSuggestionRepository(tx).recordUsage({ id: freshId(), bookmarkId, fields: ["title", "tags"] }));

    expect(await usageOf(first.workspaceId)).toEqual([{ account_id: first.accountId, bookmark_id: bookmarkId, fields_used: ["title", "tags"] }]);
  });

  it("outlives the bookmark it names, which it holds no key to", async () => {
    const { first } = await workspaceOf();
    const bookmarkId = freshId();
    await asSystem(
      db,
      (tx) => tx`INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title) VALUES (${bookmarkId}, ${first.workspaceId}, ${first.accountId}, 'https://example.com/a', 'https://example.com/a', 'example.com', 'Seed')`,
    );
    await inTenant(first, (tx) => aiSuggestionRepository(tx).recordUsage({ id: freshId(), bookmarkId, fields: ["slug"] }));

    await asSystem(db, (tx) => tx`DELETE FROM bookmarks WHERE id = ${bookmarkId}`);

    expect(await usageOf(first.workspaceId)).toHaveLength(1);
  });

  it("refuses fields outside title, slug and tags, none, and a repeat before any statement, leaving the transaction and what it wrote earlier", async () => {
    const { first } = await workspaceOf();

    const outcome = await inTenant(first, async (tx) => {
      const repository = aiSuggestionRepository(tx);
      await repository.store({ urlCanonical: URL_OF_PAGE, locale: "en", result: SUGGESTION, provider: "p", model: "m" });
      const refusals: unknown[] = [];
      for (const fields of [["title", "notes"], [], ["title", "title"]]) {
        refusals.push(await repository.recordUsage({ id: freshId(), bookmarkId: null, fields }).catch((error: unknown) => error));
      }
      await repository.recordUsage({ id: freshId(), bookmarkId: null, fields: ["slug"] });
      return refusals;
    });

    expect(outcome).toHaveLength(3);
    for (const refusal of outcome) {
      expect(refusal).toBeInstanceOf(RangeError);
    }
    expect(await rowsOf(first.workspaceId)).toHaveLength(1);
    expect(await usageOf(first.workspaceId)).toMatchObject([{ fields_used: ["slug"] }]);
  });

  it("is refused by the table for no field, a fourth entry or a field other than title, slug and tags (a repeat within three is the repository's to refuse), and cannot be changed or deleted by slugbase_app", async () => {
    const { first } = await workspaceOf();
    const insert = (fields: string) =>
      appAs(first, (tx) => tx.unsafe(`INSERT INTO ai_suggestion_usage (id, workspace_id, account_id, fields_used) VALUES ('${freshId()}', '${first.workspaceId}', '${first.accountId}', ${fields})`));

    await expect(insert(`'{}'::text[]`)).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(insert(`ARRAY['title', 'url']`)).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(insert(`ARRAY['title', 'slug', 'tags', 'title']`)).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await insert(`ARRAY['title']`);
    await expect(appAs(first, (tx) => tx`UPDATE ai_suggestion_usage SET fields_used = ARRAY['slug']`)).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    await expect(appAs(first, (tx) => tx`DELETE FROM ai_suggestion_usage`)).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
  });

  it("is a member's own: another member of the workspace and another workspace read none of it, and a row naming another member is refused", async () => {
    const a = await workspaceOf();
    const b = await workspaceOf();
    await inTenant(a.first, (tx) => aiSuggestionRepository(tx).recordUsage({ id: freshId(), bookmarkId: null, fields: ["title"] }));

    expect(await appAs(a.second, (tx) => tx`SELECT * FROM ai_suggestion_usage`)).toHaveLength(0);
    expect(await appAs(b.first, (tx) => tx`SELECT * FROM ai_suggestion_usage`)).toHaveLength(0);
    expect(await appAs(a.first, (tx) => tx`SELECT * FROM ai_suggestion_usage`)).toHaveLength(1);
    await expect(
      appAs(a.second, (tx) => tx`INSERT INTO ai_suggestion_usage (id, workspace_id, account_id, fields_used) VALUES (${freshId()}, ${a.first.workspaceId}, ${a.first.accountId}, ARRAY['title'])`),
    ).rejects.toMatchObject({ code: ROW_LEVEL_SECURITY });
  });
});
