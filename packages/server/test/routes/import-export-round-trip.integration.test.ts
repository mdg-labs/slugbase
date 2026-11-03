import { archiveBookmarks } from "@slugbase/core";
import { bookmarkArchiveTransaction } from "@slugbase/db";
import { EXPORT_VERSION, ExportDocumentSchema, FOLDER_ICONS, ImportResultSchema } from "@slugbase/contracts";
import type { EntitlementCheck } from "@slugbase/core";
import { bookmarkShapes, createIds, createRandom, type Random } from "@slugbase/testing";
import { assertBookmarkCountMatches, useTestDatabase } from "@slugbase/testing/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../../vitest.shared.ts";
import { uuidv7 } from "../../src/auth/uuidv7.ts";
import { tenantDatabase } from "../contract/support.ts";
import { HOOK_TIMEOUT_MS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// The lossless-export promise (doc 02 sections 13.2 and 13.4, doc 08 section 5.1, doc 12 Phase 4 definition of done, Q29), through the whole chain over the migrated database. A seeded generator
// builds workspaces of folders (name, icon, colour), tags, slugs, forwarding, pinned bookmarks, remembered slug choices, duplicate addresses and hostile and unicode text and descriptions with line breaks and tabs, with the named shapes of
// the development seed among them. Each is exported, the document is imported with skipDuplicates=false into an empty workspace of the same member, and the export of that workspace has to be the
// first document: only `exportedAt` and the workspace's name differ, and the document holds no identifier. The failure scenario: an exported field the import drops or rewrites, or an export that
// lists the same content in another order, fails the comparison, and a failure names the seed and the case, which run again from the same numbers. Apart from that, a plan-archived bookmark comes
// back as an ordinary one and raises `bookmark_count` by one, and the list `shared` of an export that asks for it creates nothing.

const SEEDS = [265, 20_261_103];
const CASES_PER_SEED = 50;
const EXPORT = "/api/v1/export/json";
const IMPORT = "/api/v1/import/json";
const BOOKMARKS = "/api/v1/bookmarks";
const FOLDERS = "/api/v1/folders";
const TAGS = "/api/v1/tags";
const CHOOSE = "/api/v1/go/choose";
const GRANTED: EntitlementCheck = (entitlement) => entitlement === "sharing.members" || entitlement === "sharing.teams" || entitlement === "teams.manage";
const RELAXED = { RATE_LIMIT_BULK_IP: "10000/hour", RATE_LIMIT_BULK_ACCOUNT: "10000/hour", RATE_LIMIT_WRITE_IP: "10000/min", RATE_LIMIT_WRITE_ACCOUNT: "10000/min" };

type ExportDocument = ReturnType<typeof ExportDocumentSchema.parse>;

const database = useTestDatabase();
const harness = workspaceHarness(database);

beforeAll(() => harness.start(), HOOK_TIMEOUT_MS);

afterAll(() => harness.stop());

beforeEach(async () => {
  await database().owner`TRUNCATE accounts CASCADE`;
  await database().owner`TRUNCATE workspaces CASCADE`;
  await database().owner`TRUNCATE pgboss.job`;
});

afterEach(() => assertBookmarkCountMatches(database()));

const asPerson = (as: Person): Record<string, string> => ({ cookie: as.cookie });

async function create(world: World, as: Person, path: string, body: Record<string, unknown>): Promise<string> {
  const response = await send(world, "POST", path, asPerson(as), body);
  if (response.status !== 201) {
    throw new Error(`POST ${path} answered ${String(response.status)}: ${await response.text()}`);
  }
  return ((await response.json()) as { id: string }).id;
}

async function exportOf(world: World, as: Person, query = ""): Promise<ExportDocument> {
  const response = await send(world, "GET", `${EXPORT}${query}`, asPerson(as));
  expect(response.status).toBe(200);
  return ExportDocumentSchema.parse(await response.json());
}

async function importInto(world: World, as: Person, document: unknown) {
  const response = await send(world, "POST", `${IMPORT}?skipDuplicates=false`, asPerson(as), document);
  const body: unknown = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  return ImportResultSchema.parse(body);
}

async function asSystem<T>(work: (tx: ReturnType<typeof database>["owner"]) => Promise<T>): Promise<T> {
  return database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return work(tx as unknown as ReturnType<typeof database>["owner"]);
  }) as Promise<T>;
}

async function counterOf(workspaceId: string): Promise<number | undefined> {
  const rows = await asSystem((tx) => tx<{ bookmark_count: number }[]>`SELECT bookmark_count FROM workspaces WHERE id = ${workspaceId}`);
  return rows[0]?.bookmark_count;
}

/** The two things a re-export is meant to differ in: when it was made and what the workspace is called. */
function withoutVolatile(document: ExportDocument): unknown {
  return { ...document, exportedAt: null, workspace: { name: null } };
}

// Text that has broken lists, modals and parsers; none of it holds a control character, which an import removes from the title, address, slug and names of a file (doc 10 T13) and which those therefore could not keep.
const TEXTS = [
  "Plain title",
  "<img src=x onerror=alert(1)>",
  '"><script>alert(1)</script>',
  "' OR 1=1; --",
  "{{7*7}} ${7*7} #{7*7}",
  "javascript:alert(1)",
  "&lt;b&gt;bold&lt;/b&gt; &amp; <b>bold</b>",
  "100% \\ / | ; = ? # [ ] @ ! $ ' ( ) * + , {}",
  "Ünïcödé — naïve café, ß, İstanbul, ǅ",
  "日本語のタイトル 한국어 中文",
  "دليل المستخدم لإدارة الإشارات المرجعية",
  "מדריך למשתמש לניהול סימניות",
  "SlugBase دليل (2026) מדריך 123",
  "🚀 Launch 🎉 👨‍👩‍👧‍👦 🇩🇪 👍🏽",
  "é combining and ‮right-to-left override‬ and zero​width‍joiner",
  "Tab and em space inside",
  "x",
];

// Descriptions keep a line break and a tab through an import (doc 02 section 13.1), so these are drawn beside the texts above. None holds a carriage return, which an import turns into a line break.
const DESCRIPTIONS = [...TEXTS, "line one\nline two", "a\nb\tc", "Tab\tseparated\tcolumns", "first paragraph\n\nsecond paragraph\n  - indented\n\t- tabbed", "<b>bold</b>\n<script>alert(1)</script>\n😀\tx"];

const PATHS = ["a", "docs/guide", "über/straße", "search?q=a b&x=1", "p?utm_source=newsletter&fbclid=abc", "page#section", "%E6%97%A5%E6%9C%AC", "a/../b", "emoji/🚀"];

const SLUG_STEMS = ["wiki", "mail", "docs", "go-to", "x", "a1", "0day", "long-slug-with-many-hyphens-in-it"];

interface Draft {
  readonly url: string;
  readonly title: string;
  readonly description: string | null;
  readonly pinned: boolean;
  readonly slug: string | null;
  readonly forwarding: boolean;
  readonly folders: readonly number[];
  readonly tags: readonly number[];
  readonly remember: boolean;
}

interface Plan {
  readonly folders: readonly { readonly name: string; readonly icon: string; readonly color: number }[];
  readonly tags: readonly string[];
  readonly bookmarks: readonly Draft[];
}

/** A name that no other of the case matches without regard to case: a piece of text and the number of its place. */
function nameFor(random: Random, index: number, max: number): string {
  const text = Array.from(random.pick(TEXTS)).slice(0, max - 6).join("").trim();
  return `${text} ${String(index)}`;
}

function subset(random: Random, size: number, chance: number): number[] {
  return Array.from({ length: size }, (_, index) => index).filter(() => random.chance(chance));
}

function plan(seed: number, caseNumber: number): Plan {
  const random = createRandom(seed * 1000 + caseNumber);
  const shapes = bookmarkShapes({ random, ids: createIds(random, 0x0192f3a00000), owners: ["generated"], now: new Date("2026-11-03T00:00:00Z") });
  const folders = Array.from({ length: random.int(5) }, (_, index) => ({ name: nameFor(random, index, 64), icon: random.pick(FOLDER_ICONS), color: 1 + random.int(8) }));
  const tags = Array.from({ length: random.int(6) }, (_, index) => nameFor(random, index, 40));
  const bookmarks: Draft[] = [];
  const count = 1 + random.int(10);
  for (let index = 0; index < count; index += 1) {
    const shape = random.chance(0.3) ? random.pick(shapes).bookmark : undefined;
    const earlier = bookmarks.length > 0 && random.chance(0.2) ? random.pick(bookmarks) : undefined;
    const url = shape?.url ?? earlier?.url ?? `https://example${String(random.int(3))}.com/${random.pick(PATHS)}/${String(index)}`;
    const slug = random.chance(0.45) ? `${random.pick(SLUG_STEMS)}-${String(index)}` : null;
    const forwarding = slug !== null && random.chance(0.75);
    bookmarks.push({
      url,
      title: shape?.title ?? random.pick(TEXTS),
      description: shape !== undefined ? shape.description : random.chance(0.5) ? random.pick(DESCRIPTIONS) : null,
      pinned: shape?.pinnedAt != null || random.chance(0.25),
      slug,
      forwarding,
      folders: subset(random, folders.length, 0.35),
      tags: subset(random, tags.length, 0.35),
      remember: forwarding && random.chance(0.5),
    });
  }
  return { folders, tags, bookmarks };
}

async function build(world: World, as: Person, content: Plan): Promise<void> {
  const folderIds: string[] = [];
  for (const folder of content.folders) {
    folderIds.push(await create(world, as, FOLDERS, folder));
  }
  const tagIds: string[] = [];
  for (const name of content.tags) {
    tagIds.push(await create(world, as, TAGS, { name }));
  }
  for (const draft of content.bookmarks) {
    const id = await create(world, as, BOOKMARKS, {
      url: draft.url,
      title: draft.title,
      ...(draft.description === null ? {} : { description: draft.description }),
      pinned: draft.pinned,
      ...(draft.slug === null ? {} : { slug: draft.slug, forwarding: draft.forwarding }),
      folderIds: draft.folders.map((index) => folderIds[index]),
      tagIds: draft.tags.map((index) => tagIds[index]),
    });
    if (draft.remember && draft.slug !== null) {
      const chosen = await send(world, "POST", CHOOSE, asPerson(as), { slug: draft.slug, bookmarkId: id, remember: true });
      expect(chosen.status).toBe(200);
    }
  }
}

interface Coverage {
  workspaces: number;
  bookmarks: number;
  folders: number;
  tags: number;
  pinned: number;
  slugs: number;
  notForwarding: number;
  choices: number;
  duplicates: number;
  linked: number;
}

function tally(coverage: Coverage, document: ExportDocument): void {
  coverage.workspaces += 1;
  coverage.bookmarks += document.bookmarks.length;
  coverage.folders += document.folders.length;
  coverage.tags += document.tags.length;
  coverage.pinned += document.bookmarks.filter((bookmark) => bookmark.pinned).length;
  coverage.slugs += document.bookmarks.filter((bookmark) => bookmark.slug !== null).length;
  coverage.notForwarding += document.bookmarks.filter((bookmark) => bookmark.slug !== null && !bookmark.forwarding).length;
  coverage.choices += document.goPreferences.length;
  coverage.duplicates += document.bookmarks.length - new Set(document.bookmarks.map((bookmark) => bookmark.url)).size;
  coverage.linked += document.bookmarks.filter((bookmark) => bookmark.folders.length > 0 && bookmark.tags.length > 0).length;
}

describe("export, then import into an empty workspace", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  for (const seed of SEEDS) {
    it(`gives back the document it was made from, for ${String(CASES_PER_SEED)} generated workspaces (seed ${String(seed)})`, async () => {
      const world = harness.serve({ env: RELAXED });
      const member = await harness.person(world);
      const coverage: Coverage = { workspaces: 0, bookmarks: 0, folders: 0, tags: 0, pinned: 0, slugs: 0, notForwarding: 0, choices: 0, duplicates: 0, linked: 0 };

      for (let caseNumber = 1; caseNumber <= CASES_PER_SEED; caseNumber += 1) {
        const content = plan(seed, caseNumber);
        try {
          await harness.workspaceOf([{ person: member, role: "owner" }]);
          await build(world, member, content);
          const first = await exportOf(world, member);
          expect(first.version).toBe(EXPORT_VERSION);
          expect(first.bookmarks).toHaveLength(content.bookmarks.length);

          const target = await harness.workspaceOf([{ person: member, role: "owner" }]);
          expect((await exportOf(world, member)).bookmarks).toEqual([]);
          const result = await importInto(world, member, first);
          expect(result.created).toBe(first.bookmarks.length);
          expect(result.skipped).toEqual([]);
          expect(result.failed).toEqual([]);
          expect(result.slugsDropped).toBe(0);
          expect(result.foldersCreated).toBe(first.folders.length);
          expect(result.tagsCreated).toBe(first.tags.length);

          const second = await exportOf(world, member);
          expect(withoutVolatile(second)).toEqual(withoutVolatile(first));
          expect(JSON.stringify(withoutVolatile(second))).toBe(JSON.stringify(withoutVolatile(first)));
          expect(await counterOf(target.workspaceId)).toBe(first.bookmarks.length);
          tally(coverage, first);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(`seed ${String(seed)}, case ${String(caseNumber)} failed: ${reason}`, { cause: error });
        }
      }

      expect(coverage.workspaces, "each run covers at least 50 workspaces").toBeGreaterThanOrEqual(50);
      for (const [name, value] of Object.entries(coverage)) {
        expect(value, `the generated workspaces of seed ${String(seed)} hold some ${name}`).toBeGreaterThan(0);
      }
    });
  }

});

describe("what an import does not take from an export", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("brings a plan-archived bookmark back as an ordinary one and counts it", async () => {
    const world = harness.serve({ env: RELAXED });
    const member = await harness.person(world);
    const source = await harness.workspaceOf([{ person: member, role: "owner" }]);
    await create(world, member, BOOKMARKS, { url: "https://example.com/kept", title: "Kept", slug: "kept" });
    const archived = await create(world, member, BOOKMARKS, { url: "https://example.com/old", title: "Old plan", slug: "old", pinned: true });
    await create(world, member, BOOKMARKS, { url: "https://example.com/also", title: "Also kept" });
    await tenantDatabase(database()).withTenant({ accountId: member.account.id, workspaceId: source.workspaceId, requestId: "round-trip-archive" }, async (tx) => {
      await archiveBookmarks(bookmarkArchiveTransaction(tx, uuidv7), { workspaceId: source.workspaceId, bookmarkIds: [archived] });
    });
    expect(await counterOf(source.workspaceId)).toBe(2);
    const first = await exportOf(world, member);
    expect(first.bookmarks.map((bookmark) => [bookmark.title, bookmark.planArchived])).toEqual([
      ["Kept", false],
      ["Old plan", true],
      ["Also kept", false],
    ]);

    const target = await harness.workspaceOf([{ person: member, role: "owner" }]);
    const result = await importInto(world, member, first);
    const second = await exportOf(world, member);

    expect(result.created).toBe(3);
    expect(second.bookmarks.map((bookmark) => [bookmark.title, bookmark.planArchived])).toEqual([
      ["Kept", false],
      ["Old plan", false],
      ["Also kept", false],
    ]);
    expect(second.bookmarks[1]).toMatchObject({ slug: "old", forwarding: true, pinned: true });
    expect(await counterOf(target.workspaceId)).toBe(3);
    expect(await counterOf(source.workspaceId)).toBe(2);
  });

  it("creates nothing from the list of bookmarks shared with the member", async () => {
    const world = harness.serve({ entitlements: GRANTED, env: RELAXED });
    const member = await harness.person(world);
    const colleague = await harness.person(world);
    const source = await harness.workspaceOf([
      { person: member, role: "owner" },
      { person: colleague, role: "member" },
    ]);
    await create(world, member, BOOKMARKS, { url: "https://example.com/mine", title: "Mine", slug: "mine" });
    const theirs = await create(world, colleague, BOOKMARKS, { url: "https://example.com/theirs", title: "Theirs", slug: "theirs" });
    const share = await send(world, "POST", `${BOOKMARKS}/${theirs}/shares`, asPerson(colleague), { accountId: member.account.id });
    expect(share.status).toBeLessThan(300);
    const first = await exportOf(world, member, "?includeShared=true");
    expect(first.shared.map((entry) => entry.title)).toEqual(["Theirs"]);

    const target = await harness.workspaceOf([{ person: member, role: "owner" }]);
    const result = await importInto(world, member, first);
    const second = await exportOf(world, member, "?includeShared=true");

    expect(result.created).toBe(1);
    expect(second.bookmarks.map((bookmark) => bookmark.title)).toEqual(["Mine"]);
    expect(second.shared).toEqual([]);
    expect(await counterOf(target.workspaceId)).toBe(1);
    expect((await exportOf(world, colleague)).bookmarks.map((bookmark) => bookmark.title)).toEqual(["Theirs"]);
    expect(await counterOf(source.workspaceId)).toBe(2);
  });
});
