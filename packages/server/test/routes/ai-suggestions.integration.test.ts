import { setTimeout as sleep } from "node:timers/promises";
import type { AiSuggestPort, AiSuggestRequest, AiSuggestion } from "@slugbase/core";
import { FakeAi, LimitedEntitlementSource } from "@slugbase/testing";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bearer, HOOK_TIMEOUT_MS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// POST /api/v1/ai/suggestions, the operation suggestBookmarkDetails (doc 04 sections 7 and 10.8, doc 02 section 14, doc 05 section 2.8, doc 10 T1, T11 and T13), through the whole chain over the
// migrated database, with the fake of the AI port. The failure scenario: the suggestion cached for a member of workspace A is never served to a member of
// workspace B or to another member of A for the same address and language, and a member whose workspace toggle is off, who opted out, whose workspace has no
// entitlement or whose instance has no AI configured gets a refusal and the provider is never asked, not even for a suggestion that is cached.

const TEST_TIMEOUT_MS = 60_000;
const SUGGESTIONS = "/api/v1/ai/suggestions";
const BOOKMARKS = "/api/v1/bookmarks";
const PAGE_URL = "https://example.test/docs";

const database = useTestDatabase();
const harness = workspaceHarness(database);

beforeAll(() => harness.start(), HOOK_TIMEOUT_MS);

afterAll(() => harness.stop());

beforeEach(async () => {
  await database().owner`TRUNCATE accounts CASCADE`;
  await database().owner`TRUNCATE workspaces CASCADE`;
  await database().owner`TRUNCATE pgboss.job`;
});

const suggest = (world: World, as: Person, body: Record<string, unknown> = {}) => send(world, "POST", SUGGESTIONS, { cookie: as.cookie }, { url: PAGE_URL, locale: "en", ...body });

type ServeOptions = Parameters<typeof harness.serve>[0];

/** A server whose entitlement source grants every workspace the entitlements of the catalog, unless the test brings its own source or check. */
function serve(options: NonNullable<ServeOptions> = {}): World {
  return harness.serve({ ...(options.entitlements === undefined && options.entitlementSource === undefined ? { entitlementSource: new LimitedEntitlementSource() } : {}), ...options });
}

async function setup(world: World) {
  const owner = await harness.person(world);
  const colleague = await harness.person(world);
  const stranger = await harness.person(world);
  const shared = await harness.workspaceOf([
    { person: owner, role: "owner" },
    { person: colleague, role: "member" },
  ]);
  const other = await harness.workspaceOf([{ person: stranger, role: "owner" }]);
  return { owner, colleague, stranger, shared, other };
}

async function tag(world: World, as: Person, name: string): Promise<void> {
  expect((await send(world, "POST", "/api/v1/tags", { cookie: as.cookie }, { name })).status).toBe(201);
}

async function bookmark(world: World, as: Person, body: Record<string, unknown>): Promise<Response> {
  return send(world, "POST", BOOKMARKS, { cookie: as.cookie }, { url: "https://example.test/saved", title: "Saved", ...body });
}

interface Cached {
  readonly workspace_id: string;
  readonly account_id: string;
  readonly url_canonical: string;
  readonly locale: string;
  readonly result: { title: string; slug: string | null; tags: string[]; confidence: number };
  readonly provider: string;
  readonly model: string;
}

async function cachedRows(): Promise<Cached[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<Cached[]>`SELECT workspace_id, account_id, url_canonical, locale, result, provider, model FROM ai_suggestions ORDER BY workspace_id, account_id, locale`;
  });
  return [...rows];
}

async function usageRows(): Promise<{ account_id: string; bookmark_id: string | null; fields_used: string[] }[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ account_id: string; bookmark_id: string | null; fields_used: string[] }[]>`SELECT account_id, bookmark_id, fields_used FROM ai_suggestion_usage ORDER BY created_at, id`;
  });
  return [...rows];
}

async function counts(): Promise<{ bookmarks: number; tags: number }> {
  const [row] = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ bookmarks: number; tags: number }[]>`SELECT (SELECT count(*) FROM bookmarks)::int AS bookmarks, (SELECT count(*) FROM tags)::int AS tags`;
  });
  return row ?? { bookmarks: -1, tags: -1 };
}

async function setToggle(workspaceId: string, enabled: boolean): Promise<void> {
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`UPDATE workspace_settings SET ai_enabled = ${enabled} WHERE workspace_id = ${workspaceId}`;
  });
}

async function setOptOut(person: Person, optedOut: boolean): Promise<void> {
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`UPDATE accounts SET ai_opt_out = ${optedOut} WHERE id = ${person.account.id}`;
  });
}

/** An AI port that never answers within the budget it is given, like a provider that hangs. */
function hangingAi(): AiSuggestPort & { readonly requests: AiSuggestRequest[] } {
  const requests: AiSuggestRequest[] = [];
  return {
    available: true,
    requests,
    async suggest(request): Promise<AiSuggestion> {
      requests.push(request);
      await sleep(10_000);
      throw new Error("too late");
    },
  };
}

/** An AI port that runs `before` when it is asked, and then answers as `inner` does: the moment the provider is slow in. */
function interposedAi(inner: FakeAi, before: () => Promise<void>): AiSuggestPort {
  return {
    available: true,
    async suggest(request): Promise<AiSuggestion> {
      await before();
      return inner.suggest(request);
    },
  };
}

describe("a member who may be answered", () => {
  it(
    "gets the provider's suggestion for the canonical URL with the names of their own tags only, then the cached one without a second call",
    async () => {
      const ai = new FakeAi();
      ai.respondWith({ title: "The docs", slug: "docs", tags: ["reading", "new-idea"], confidence: 0.9 });
      const world = serve({ ai });
      const { owner, colleague } = await setup(world);
      await tag(world, owner, "Reading");
      await tag(world, colleague, "Colleague secret");

      const first = await suggest(world, owner, { url: "HTTPS://Example.test/docs/?utm_source=feed#top", locale: "EN", metadata: { title: "Docs", description: "All of them" } });
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({ title: "The docs", slug: "docs", tags: ["Reading", "new-idea"], confidence: 0.9 });
      expect(ai.requests).toEqual([{ url: PAGE_URL, language: "en", metadata: { title: "Docs", description: "All of them" }, tags: ["Reading"] }]);

      const second = await suggest(world, owner, { metadata: { title: "Another title" } });
      expect(second.status).toBe(200);
      expect(await second.json()).toEqual({ title: "The docs", slug: "docs", tags: ["Reading", "new-idea"], confidence: 0.9 });
      expect(ai.requests).toHaveLength(1);
      expect((await cachedRows()).map((row) => [row.account_id, row.url_canonical, row.locale])).toEqual([[owner.account.id, PAGE_URL, "en"]]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "applies nothing: no bookmark, slug or tag is created for a suggestion",
    async () => {
      const ai = new FakeAi();
      ai.respondWith({ title: "The docs", slug: "docs", tags: ["brand-new"], confidence: 0.9 });
      const world = serve({ ai });
      const { owner } = await setup(world);
      const before = await counts();

      expect((await suggest(world, owner)).status).toBe(200);

      expect(await counts()).toEqual(before);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "drops a slug outside the grammar and one the member already uses, also from the cache, and keeps the member's own spelling of a tag first, at most five",
    async () => {
      const ai = new FakeAi();
      ai.respondWith({ title: "The docs", slug: "docs", tags: ["alpha", "reading", "beta", "gamma", "delta", "epsilon"], confidence: 0.5 });
      const world = serve({ ai });
      const { owner, colleague } = await setup(world);
      await tag(world, owner, "Reading");

      const free = await (await suggest(world, owner)).json();
      expect(free).toMatchObject({ slug: "docs", tags: ["Reading", "alpha", "beta", "gamma", "delta"] });

      expect((await bookmark(world, owner, { slug: "docs" })).status).toBe(201);
      expect(await (await suggest(world, owner)).json()).toMatchObject({ slug: null });
      expect(ai.requests).toHaveLength(1);

      // the slug is the owner's; the colleague uses none, so their own suggestion keeps it
      expect(await (await suggest(world, colleague)).json()).toMatchObject({ slug: "docs" });

      ai.respondWith({ title: "Other", slug: "Not A Slug!", tags: [], confidence: 0.5 });
      expect(await (await suggest(world, owner, { url: "https://example.test/other" })).json()).toMatchObject({ title: "Other", slug: null });
    },
    TEST_TIMEOUT_MS,
  );
});

describe("the cache of a member", () => {
  it(
    "is never served to another member of the workspace or to a member of another workspace for the same address and language",
    async () => {
      const ai = new FakeAi();
      const world = serve({ ai });
      const { owner, colleague, stranger, shared, other } = await setup(world);
      await tag(world, owner, "Owner tag");
      await tag(world, colleague, "Colleague tag");
      await tag(world, stranger, "Stranger tag");

      ai.respondWith({ title: "For the owner", slug: "one", tags: [], confidence: 0.5 });
      expect(await (await suggest(world, owner)).json()).toMatchObject({ title: "For the owner" });
      ai.respondWith({ title: "For the colleague", slug: "two", tags: [], confidence: 0.5 });
      expect(await (await suggest(world, colleague)).json()).toMatchObject({ title: "For the colleague" });
      ai.respondWith({ title: "For the stranger", slug: "three", tags: [], confidence: 0.5 });
      expect(await (await suggest(world, stranger)).json()).toMatchObject({ title: "For the stranger" });

      expect(ai.requests.map((request) => request.tags)).toEqual([["Owner tag"], ["Colleague tag"], ["Stranger tag"]]);
      const rows = await cachedRows();
      expect(rows.map((row) => [row.workspace_id, row.account_id, row.result.title]).sort()).toEqual(
        [
          [shared.workspaceId, owner.account.id, "For the owner"],
          [shared.workspaceId, colleague.account.id, "For the colleague"],
          [other.workspaceId, stranger.account.id, "For the stranger"],
        ].sort(),
      );
      // each is served their own from the cache, without another call
      ai.respondWith({ title: "Never asked", slug: "x", tags: [], confidence: 0.5 });
      expect(await (await suggest(world, owner)).json()).toMatchObject({ title: "For the owner" });
      expect(await (await suggest(world, colleague)).json()).toMatchObject({ title: "For the colleague" });
      expect(await (await suggest(world, stranger)).json()).toMatchObject({ title: "For the stranger" });
      expect(ai.requests).toHaveLength(3);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps a language of its own, and asks the provider again once the entry has expired by the database clock",
    async () => {
      const ai = new FakeAi();
      const world = serve({ ai });
      const { owner } = await setup(world);

      await suggest(world, owner);
      await suggest(world, owner, { locale: "de" });
      expect(ai.requests.map((request) => request.language)).toEqual(["en", "de"]);

      await database().owner.begin(async (tx) => {
        await tx`SET LOCAL ROLE slugbase_system`;
        await tx`UPDATE ai_suggestions SET created_at = now() - interval '31 days', expires_at = now() - interval '1 day' WHERE locale = 'en'`;
      });
      await suggest(world, owner);
      await suggest(world, owner, { locale: "de" });

      expect(ai.requests.map((request) => request.language)).toEqual(["en", "de", "en"]);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("a member who may not be answered", () => {
  it(
    "gets 403 forbidden when the workspace toggle is off, also for a cached suggestion, and the provider is not asked again",
    async () => {
      const ai = new FakeAi();
      const world = serve({ ai });
      const { owner, colleague, shared } = await setup(world);
      expect((await suggest(world, owner)).status).toBe(200);
      expect(ai.requests).toHaveLength(1);

      await setToggle(shared.workspaceId, false);

      for (const person of [owner, colleague]) {
        const refused = await suggest(world, person);
        expect(refused.status).toBe(403);
        expect(await refused.json()).toMatchObject({ code: "forbidden" });
      }
      expect(ai.requests).toHaveLength(1);

      await setToggle(shared.workspaceId, true);
      expect((await suggest(world, owner)).status).toBe(200);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "gets 403 forbidden when they opted out, also for a cached suggestion, while a colleague who did not still gets theirs",
    async () => {
      const ai = new FakeAi();
      const world = serve({ ai });
      const { owner, colleague } = await setup(world);
      expect((await suggest(world, owner)).status).toBe(200);
      await setOptOut(owner, true);

      const refused = await suggest(world, owner);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ code: "forbidden" });
      expect(ai.requests).toHaveLength(1);

      expect((await suggest(world, colleague)).status).toBe(200);
      expect(ai.requests).toHaveLength(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "gets 403 entitlement_required when the workspace does not hold ai.suggestions, decided on the server, and the provider is not asked",
    async () => {
      const ai = new FakeAi();
      const world = serve({ ai, entitlementSource: new LimitedEntitlementSource().grant("ai.suggestions", false) });
      const { owner } = await setup(world);

      const refused = await suggest(world, owner);

      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ code: "entitlement_required" });
      expect(ai.requests).toEqual([]);
      expect(await cachedRows()).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "ends the request, and does not ask the provider, when the entitlement cannot be read",
    async () => {
      const ai = new FakeAi();
      const world = serve({ ai, entitlements: () => Promise.reject(new Error("the entitlement source is down")) });
      const { owner } = await setup(world);

      const refused = await suggest(world, owner);

      expect(refused.status).toBeGreaterThanOrEqual(500);
      expect(ai.requests).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "gets 503 ai_unavailable when the instance has no AI configured, with nothing cached",
    async () => {
      const world = serve();
      const { owner } = await setup(world);

      const refused = await suggest(world, owner);

      expect(refused.status).toBe(503);
      expect(await refused.json()).toMatchObject({ code: "ai_unavailable" });
      expect(await cachedRows()).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "is refused with 403 token_scope for an API token that may only read, and with 422 for a request outside the contract, without asking the provider",
    async () => {
      const ai = new FakeAi();
      const world = serve({ ai });
      const { owner, shared } = await setup(world);
      const reader = await harness.token(shared.workspaceId, owner, "read");

      const tokenRefusal = await send(world, "POST", SUGGESTIONS, bearer(reader), { url: PAGE_URL, locale: "en" });
      expect(tokenRefusal.status).toBe(403);
      expect(await tokenRefusal.json()).toMatchObject({ code: "token_scope" });

      for (const body of [
        { url: "javascript:alert(1)", locale: "en" },
        { url: "data:text/html,hi", locale: "en" },
        { url: PAGE_URL, locale: "not a language" },
        { url: PAGE_URL, locale: "en", metadata: { title: "t".repeat(301) } },
        { url: PAGE_URL, locale: "en", metadata: { description: "d".repeat(1001) } },
        { url: PAGE_URL, locale: "en", metadata: { title: "a\u0000b" } },
        { url: PAGE_URL, locale: "en", extra: true },
        { url: "", locale: "en" },
      ]) {
        const refused = await send(world, "POST", SUGGESTIONS, { cookie: owner.cookie }, body);
        expect(refused.status, JSON.stringify(body)).toBe(422);
      }
      expect(ai.requests).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "gets 422 url_not_allowed for a scheme other than http and https",
    async () => {
      const world = serve({ ai: new FakeAi() });
      const { owner } = await setup(world);

      const refused = await suggest(world, owner, { url: "ftp://example.test/file" });

      expect(refused.status).toBe(422);
      expect(await refused.json()).toMatchObject({ code: "url_not_allowed" });
    },
    TEST_TIMEOUT_MS,
  );
});

describe("a provider that fails", () => {
  it.each(["ai_failed", "ai_timeout", "ai_invalid_response"] as const)(
    "answers 502 upstream_failed for %s and caches nothing, and the next request asks the provider again",
    async (code) => {
      const ai = new FakeAi();
      ai.failWith(code);
      const world = serve({ ai });
      const { owner } = await setup(world);

      const failed = await suggest(world, owner);

      expect(failed.status).toBe(502);
      expect(await failed.json()).toMatchObject({ code: "upstream_failed" });
      expect(await cachedRows()).toEqual([]);

      ai.reset();
      expect((await suggest(world, owner)).status).toBe(200);
      expect(await cachedRows()).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers 502 upstream_failed for a provider that does not answer within the budget, and caches nothing",
    async () => {
      const ai = hangingAi();
      const world = serve({ ai, aiBudgetMs: 150 });
      const { owner } = await setup(world);

      const started = Date.now();
      const failed = await suggest(world, owner);

      expect(failed.status).toBe(502);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(ai.requests).toHaveLength(1);
      expect(await cachedRows()).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers 502 upstream_failed for a title or a tag that holds a lone surrogate, which the cache cannot store, and caches nothing",
    async () => {
      const ai = new FakeAi();
      const world = serve({ ai });
      const { owner } = await setup(world);

      for (const answer of [
        { title: "A\ud83dB", slug: "docs", tags: [], confidence: 0.5 },
        { title: "Docs", slug: "docs", tags: ["t\ude00u"], confidence: 0.5 },
      ]) {
        ai.respondWith(answer);
        const failed = await suggest(world, owner);
        expect(failed.status).toBe(502);
        expect(await failed.json()).toMatchObject({ code: "upstream_failed" });
        expect(await cachedRows()).toEqual([]);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers 404 not_found, and caches nothing, for a member who left the workspace while the provider answered",
    async () => {
      const ai = new FakeAi();
      const world = serve({
        ai: interposedAi(ai, async () => {
          await database().owner.begin(async (tx) => {
            await tx`SET LOCAL ROLE slugbase_system`;
            await tx`DELETE FROM workspace_members WHERE workspace_id = ${shared.workspaceId} AND account_id = ${colleague.account.id}`;
          });
        }),
      });
      const { colleague, shared } = await setup(world);

      const answered = await suggest(world, colleague);

      expect(answered.status).toBe(404);
      expect(await answered.json()).toMatchObject({ code: "not_found" });
      expect(ai.requests).toHaveLength(1);
      expect(await cachedRows()).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers 200 for a URL and metadata that hold a lone surrogate, and caches an address that is well formed",
    async () => {
      const ai = new FakeAi();
      ai.respondWith({ title: "The page", slug: "page", tags: [], confidence: 0.5 });
      const world = serve({ ai });
      const { owner } = await setup(world);

      const answered = await suggest(world, owner, { url: "https://example.test/a\ud83db", metadata: { title: "T\ud83dU", description: "D\ude00E" } });

      expect(answered.status).toBe(200);
      expect(ai.requests).toHaveLength(1);
      expect(ai.requests[0]?.url.isWellFormed()).toBe(true);
      expect((await cachedRows()).map((row) => row.url_canonical.isWellFormed())).toEqual([true]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers 502 upstream_failed for an answer that cannot be used and caches nothing",
    async () => {
      const ai = new FakeAi();
      ai.respondWith({ title: "   ", slug: "docs", tags: [], confidence: 0.5 });
      const world = serve({ ai });
      const { owner } = await setup(world);

      expect((await suggest(world, owner)).status).toBe(502);
      expect(await cachedRows()).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("the ai rate bucket", () => {
  it(
    "is taken before the cache is read: a member cannot spend requests past the limit by mixing hits and misses",
    async () => {
      const ai = new FakeAi();
      const world = serve({ ai, env: { RATE_LIMIT_AI_IP: "100/hour", RATE_LIMIT_AI_ACCOUNT: "3/hour", RATE_LIMIT_AI_WORKSPACE: "100/hour" } });
      const { owner, colleague } = await setup(world);

      expect((await suggest(world, owner)).status).toBe(200);
      expect((await suggest(world, owner)).status).toBe(200);
      expect((await suggest(world, owner, { url: "https://example.test/second" })).status).toBe(200);
      const limited = await suggest(world, owner);

      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
      expect(ai.requests).toHaveLength(2);
      // the account bucket is the owner's alone
      expect((await suggest(world, colleague)).status).toBe(200);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "is shared by the members of a workspace for its per-workspace limit",
    async () => {
      const ai = new FakeAi();
      const world = serve({ ai, env: { RATE_LIMIT_AI_IP: "100/hour", RATE_LIMIT_AI_ACCOUNT: "100/hour", RATE_LIMIT_AI_WORKSPACE: "2/hour" } });
      const { owner, colleague, stranger } = await setup(world);

      expect((await suggest(world, owner)).status).toBe(200);
      expect((await suggest(world, colleague)).status).toBe(200);
      expect((await suggest(world, owner)).status).toBe(429);
      expect((await suggest(world, stranger)).status).toBe(200);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("the fields a save took from a suggestion", () => {
  async function aiWorld(options: { readonly configured: boolean } = { configured: true }) {
    const world = serve(options.configured ? { ai: new FakeAi() } : {});
    return { world, ...(await setup(world)) };
  }

  it(
    "are counted once for a creation, in the same transaction, as the fields and the bookmark and never as content",
    async () => {
      const { world, owner } = await aiWorld();

      const created = await bookmark(world, owner, { title: "Secret title", slug: "secret", aiFields: ["tags", "title", "tags"] });

      expect(created.status).toBe(201);
      const { id } = (await created.json()) as { id: string };
      expect(await usageRows()).toEqual([{ account_id: owner.account.id, bookmark_id: id, fields_used: ["title", "tags"] }]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "are counted for an update that writes, not for one that changes nothing, and not for aiFields alone",
    async () => {
      const { world, owner } = await aiWorld();
      const created = await bookmark(world, owner, {});
      const { id } = (await created.json()) as { id: string };
      expect(await usageRows()).toEqual([]);
      const patch = (body: Record<string, unknown>) => send(world, "PATCH", `${BOOKMARKS}/${id}`, { cookie: owner.cookie }, body);

      expect((await patch({ title: "New title", aiFields: ["title"] })).status).toBe(200);
      expect((await patch({ title: "New title", aiFields: ["title"] })).status).toBe(200);
      expect((await patch({ aiFields: ["slug"] })).status).toBe(200);
      expect((await patch({ pinned: true })).status).toBe(200);

      expect(await usageRows()).toEqual([{ account_id: owner.account.id, bookmark_id: id, fields_used: ["title"] }]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "are not an error when AI is not configured, off for the workspace, opted out or not entitled: the bookmark is saved and the claim counted",
    async () => {
      const { world, owner, shared } = await aiWorld({ configured: false });
      await setToggle(shared.workspaceId, false);
      await setOptOut(owner, true);

      const created = await bookmark(world, owner, { aiFields: ["slug", "title", "tags"] });

      expect(created.status).toBe(201);
      expect(await usageRows()).toMatchObject([{ fields_used: ["title", "slug", "tags"] }]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "are optional: a creation without them counts nothing, and an unknown field or a fourth one is 422 with nothing written",
    async () => {
      const { world, owner } = await aiWorld();

      expect((await bookmark(world, owner, {})).status).toBe(201);
      expect((await bookmark(world, owner, { aiFields: [] })).status).toBe(201);
      expect(await usageRows()).toEqual([]);

      const before = await counts();
      expect((await bookmark(world, owner, { aiFields: ["url"] })).status).toBe(422);
      expect((await bookmark(world, owner, { aiFields: ["title", "slug", "tags", "title"] })).status).toBe(422);
      expect(await counts()).toEqual(before);
      expect(await usageRows()).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "are not counted for a creation that is refused",
    async () => {
      const { world, owner } = await aiWorld();
      expect((await bookmark(world, owner, { slug: "taken" })).status).toBe(201);

      const refused = await bookmark(world, owner, { url: "https://example.test/other", slug: "taken", aiFields: ["slug"] });

      expect(refused.status).toBe(409);
      expect(await usageRows()).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});

