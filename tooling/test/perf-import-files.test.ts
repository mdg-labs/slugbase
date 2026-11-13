import { describe, expect, it } from "vitest";
import { buildImportFiles, buildJsonFile, buildNetscapeFile } from "../../packages/testing/src/seed/import-files.ts";

// The files of the repeats of the import phase (scripts/perf/budgets.js IMPORT_PHASE): the pair is imported more than once into the same workspace, so a repeat's files must name nothing an earlier repeat's did,
// or the import would skip the bookmarks as duplicates, drop its slugs as taken and create no folders or tags, and be a smaller import than the first. The files of the first repeat are what they were before there were
// repeats (packages/testing/test/import-files.test.ts holds them).

interface JsonBookmark {
  readonly url: string;
  readonly slug?: string;
  readonly folders: readonly string[];
  readonly tags: readonly string[];
}

interface JsonDocument {
  readonly folders: readonly { readonly name: string }[];
  readonly tags: readonly string[];
  readonly bookmarks: readonly JsonBookmark[];
}

const COLLIDING = ["docs", "gh", "jira"];
const REPEATS = [0, 1, 2, 5];
// The repeats whose names are compared for disjointness: the first (whose names carry no marker), the second (the first with one) and the eleventh, whose marker `r10` begins with the second's `r1`. Every repeat from the second on is
// made by the same code from its number alone, so two of them tell apart any two; more would only build more files.
const COMPARED = [0, 1, 10];
const links = (body: string): string[] => [...body.matchAll(/<A HREF="([^"]+)"/g)].map((match) => match[1] ?? "");
const folders = (body: string): string[] => [...body.matchAll(/<H3>([^<]+)<\/H3>/g)].map((match) => match[1] ?? "");
const tagsOf = (body: string): string[] => [...body.matchAll(/TAGS="([^"]+)"/g)].flatMap((match) => (match[1] ?? "").split(","));

// Each repeat's files are built, and the JSON parsed, once for the tests of this file that read them (building a file of 5000 bookmarks is the cost of these tests); the ones that build files to compare them with others do so themselves.
const memoized = <Value>(make: (repeat: number) => Value): ((repeat: number) => Value) => {
  const made = new Map<number, Value>();
  return (repeat) => {
    const known = made.get(repeat);
    if (known !== undefined) {
      return known;
    }
    const value = make(repeat);
    made.set(repeat, value);
    return value;
  };
};
const netscapeOf = memoized((repeat) => buildNetscapeFile({ repeat }));
const jsonOf = memoized((repeat) => buildJsonFile({ collidingSlugs: COLLIDING, repeat }));
const documentOf = memoized((repeat) => JSON.parse(jsonOf(repeat).body) as JsonDocument);

describe("the files of the repeats of the import phase", () => {
  it("makes the first repeat the files that are made with no repeat", () => {
    expect(buildNetscapeFile({ repeat: 0 }).body).toBe(buildNetscapeFile().body);
    expect(buildJsonFile({ collidingSlugs: COLLIDING, repeat: 0 }).body).toBe(buildJsonFile({ collidingSlugs: COLLIDING }).body);
    expect(buildImportFiles({ collidingSlugs: COLLIDING }).json.body).toBe(buildJsonFile({ collidingSlugs: COLLIDING }).body);
  });

  it("gives each repeat addresses, folders and tags that no other repeat's file names, in both files", () => {
    const netscape = COMPARED.map((repeat) => netscapeOf(repeat).body);
    const json = COMPARED.map((repeat) => documentOf(repeat));
    const disjoint = (sets: readonly (readonly string[])[]): void => {
      const all = sets.flat();
      expect(new Set(all).size).toBe(sets.reduce((sum, set) => sum + new Set(set).size, 0));
      expect(all.length).toBeGreaterThan(0);
    };
    disjoint(netscape.map((body) => links(body)));
    disjoint(netscape.map((body) => [...new Set(folders(body))]));
    disjoint(netscape.map((body) => [...new Set(tagsOf(body))]));
    disjoint(json.map((document) => document.bookmarks.map((bookmark) => bookmark.url)));
    disjoint(json.map((document) => document.folders.map((folder) => folder.name)));
    disjoint(json.map((document) => [...document.tags]));
    // The slugs a repeat keeps are its own too; the ones it asks for from the importer, which the importer holds from the seed, are the same in every repeat and are dropped in every one.
    const kept = json.map((document) => document.bookmarks.flatMap((bookmark) => (bookmark.slug?.startsWith("json-import-") === true ? [bookmark.slug] : [])));
    disjoint(kept.map((slugs) => [...new Set(slugs)]));
    for (const document of json) {
      expect(document.bookmarks.some((bookmark) => bookmark.slug !== undefined && COLLIDING.includes(bookmark.slug))).toBe(true);
    }
  });

  it("keeps a repeat the size of the first, so that every import does the same work", () => {
    const first = buildNetscapeFile();
    const firstJson = buildJsonFile({ collidingSlugs: COLLIDING });
    for (const repeat of REPEATS) {
      const netscape = netscapeOf(repeat);
      const json = jsonOf(repeat);
      expect(netscape.bookmarks).toBe(5000);
      expect(json.bookmarks).toBe(5000);
      expect(netscape.bytes).toBe(first.bytes);
      // The JSON file is longer by the marker only.
      expect(Math.abs(json.bytes - firstJson.bytes)).toBeLessThan(5000 * 40);
      expect(links(netscape.body)).toHaveLength(5000);
      expect(folders(netscape.body)).toHaveLength(40);
    }
  });

  it("gives every slug a repeat keeps the grammar of a slug and the marker of its repeat, and every address a bookmark's length", () => {
    for (const repeat of REPEATS.filter((value) => value > 0)) {
      const document = documentOf(repeat);
      const kept = document.bookmarks.flatMap((bookmark) => (bookmark.slug?.startsWith("json-import-") === true ? [bookmark.slug] : []));
      expect(kept.length).toBeGreaterThan(1000);
      for (const slug of kept) {
        expect(slug).toMatch(new RegExp(`^json-import-r${String(repeat)}-\\d{5}$`));
      }
      for (const bookmark of document.bookmarks) {
        expect(bookmark.url).toMatch(new RegExp(`^https://json\\.import\\.example\\.test/r${String(repeat)}/p/\\d{5}$`));
      }
      for (const link of links(netscapeOf(repeat).body)) {
        expect(link.length).toBeLessThanOrEqual(2048);
        expect(link).toMatch(new RegExp(`^https://netscape\\.import\\.example\\.test/r${String(repeat)}/p/\\d{5}/a*$`));
      }
    }
  });

  it("refuses a repeat that is not a whole number from 0", () => {
    for (const repeat of [-1, 1.5, Number.NaN]) {
      expect(() => buildNetscapeFile({ repeat })).toThrow(RangeError);
      expect(() => buildJsonFile({ repeat })).toThrow(RangeError);
    }
  });
});
