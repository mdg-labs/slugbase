import { describe, expect, it } from "vitest";
import { resolveSlug, type GoAccess, type GoBookmarkSummary, type GoCandidate, type GoCandidateSet } from "../../src/index.ts";

// The choice order of Q25 (doc 02 section 6.2): a remembered preference that is still a candidate, then the caller's own bookmark, then the one shared candidate,
// then the several shared candidates, then none. The store decides who can read what; these tests give the service the candidates a store would find.

const ME = "0192f3a0-bbbb-7000-8000-00000000000a";
const ANN = "0192f3a0-bbbb-7000-8000-00000000000b";
const BEN = "0192f3a0-bbbb-7000-8000-00000000000c";

function candidate(id: string, ownerId: string | null, access: GoAccess = ownerId === ME ? "owner" : "direct"): GoCandidate {
  return { id, ownerId, url: `https://example.com/${id}`, access };
}

function summary(id: string, title: string, ownerId: string | null, ownerName: string | null): GoBookmarkSummary {
  return { id, title, host: "example.com", ownerId, ownerName };
}

function store(found: GoCandidateSet, summaries: readonly GoBookmarkSummary[]) {
  const asked: { slug: string; accountId: string }[] = [];
  return {
    asked,
    dependencies: {
      store: {
        candidates: (request: { slug: string; accountId: string }) => {
          asked.push(request);
          return Promise.resolve(found);
        },
        summaries: (ids: readonly string[]) => Promise.resolve(summaries.filter((entry) => ids.includes(entry.id))),
      },
    },
  };
}

const MINE = candidate("0192f3a0-aaaa-7000-8000-000000000001", ME);
const ANNS = candidate("0192f3a0-aaaa-7000-8000-000000000002", ANN);
const BENS = candidate("0192f3a0-aaaa-7000-8000-000000000003", BEN, "team");
const SUMMARIES = [
  summary(MINE.id, "My mail", ME, "Me"),
  summary(ANNS.id, "Ann's mail", ANN, "Ann"),
  summary(BENS.id, "ben's mail", BEN, "Ben"),
];

describe("resolveSlug", () => {
  it("is none for a slug nobody the caller can read has", async () => {
    const { dependencies } = store({ candidates: [], preferredId: undefined }, []);

    expect(await resolveSlug(dependencies, { accountId: ME, slug: "mail" })).toEqual({ kind: "none" });
  });

  it("is none, without asking the store, for a slug outside the grammar", async () => {
    const { asked, dependencies } = store({ candidates: [MINE], preferredId: undefined }, SUMMARIES);

    for (const slug of ["", "   ", "-mail", "a b", "mail/", "mail?x=1", "ä", "a".repeat(65)]) {
      expect(await resolveSlug(dependencies, { accountId: ME, slug }), JSON.stringify(slug)).toEqual({ kind: "none" });
    }
    expect(asked).toEqual([]);
  });

  it("trims and lower-cases the slug and the account before it asks the store", async () => {
    const { asked, dependencies } = store({ candidates: [], preferredId: undefined }, []);

    await resolveSlug(dependencies, { accountId: ME.toUpperCase(), slug: "  Mail  " });

    expect(asked).toEqual([{ slug: "mail", accountId: ME }]);
  });

  it("names the remembered choice when it is still a candidate, before the caller's own bookmark", async () => {
    const { dependencies } = store({ candidates: [MINE, ANNS, BENS], preferredId: ANNS.id }, SUMMARIES);

    expect(await resolveSlug(dependencies, { accountId: ME, slug: "mail" })).toEqual({
      kind: "preferred",
      bookmark: { id: ANNS.id, title: "Ann's mail", host: "example.com", owner: { accountId: ANN, displayName: "Ann" }, sharedVia: "direct" },
    });
  });

  it("falls back to the caller's own bookmark when the remembered choice is no longer a candidate", async () => {
    const { dependencies } = store({ candidates: [MINE, BENS], preferredId: ANNS.id }, SUMMARIES);

    expect(await resolveSlug(dependencies, { accountId: ME, slug: "mail" })).toEqual({
      kind: "single",
      bookmark: { id: MINE.id, title: "My mail", host: "example.com", owner: null, sharedVia: null },
    });
  });

  it("names the caller's own bookmark before any shared one", async () => {
    const { dependencies } = store({ candidates: [ANNS, MINE, BENS], preferredId: undefined }, SUMMARIES);

    const resolution = await resolveSlug(dependencies, { accountId: ME, slug: "mail" });

    expect(resolution).toMatchObject({ kind: "single", bookmark: { id: MINE.id } });
  });

  it("names the one shared candidate with who owns it and how it is shared", async () => {
    const { dependencies } = store({ candidates: [BENS], preferredId: undefined }, SUMMARIES);

    expect(await resolveSlug(dependencies, { accountId: ME, slug: "mail" })).toEqual({
      kind: "single",
      bookmark: { id: BENS.id, title: "ben's mail", host: "example.com", owner: { accountId: BEN, displayName: "Ben" }, sharedVia: "team" },
    });
  });

  it("lists several shared candidates in the order of their titles, without regard to case", async () => {
    const { dependencies } = store({ candidates: [BENS, ANNS], preferredId: undefined }, SUMMARIES);

    const resolution = await resolveSlug(dependencies, { accountId: ME, slug: "mail" });

    expect(resolution.kind).toBe("multiple");
    expect(resolution.kind === "multiple" ? resolution.candidates.map((entry) => entry.id) : []).toEqual([ANNS.id, BENS.id]);
  });

  it("names no owner for a shared bookmark whose owner has left", async () => {
    const orphan = candidate("0192f3a0-aaaa-7000-8000-000000000004", null, "folder");
    const { dependencies } = store({ candidates: [orphan], preferredId: undefined }, [summary(orphan.id, "Orphan", null, null)]);

    expect(await resolveSlug(dependencies, { accountId: ME, slug: "mail" })).toEqual({
      kind: "single",
      bookmark: { id: orphan.id, title: "Orphan", host: "example.com", owner: null, sharedVia: "folder" },
    });
  });

  it("leaves out a candidate that was deleted between the two reads, and decides over the rest", async () => {
    const gone = store({ candidates: [MINE, ANNS], preferredId: ANNS.id }, [SUMMARIES[0] as GoBookmarkSummary]);
    const nothingLeft = store({ candidates: [MINE], preferredId: undefined }, []);
    const oneLeft = store({ candidates: [ANNS, BENS], preferredId: undefined }, [SUMMARIES[2] as GoBookmarkSummary]);

    expect(await resolveSlug(gone.dependencies, { accountId: ME, slug: "mail" })).toMatchObject({ kind: "single", bookmark: { id: MINE.id } });
    expect(await resolveSlug(nothingLeft.dependencies, { accountId: ME, slug: "mail" })).toEqual({ kind: "none" });
    expect(await resolveSlug(oneLeft.dependencies, { accountId: ME, slug: "mail" })).toMatchObject({ kind: "single", bookmark: { id: BENS.id } });
  });

  it("never names an address", async () => {
    const { dependencies } = store({ candidates: [MINE], preferredId: MINE.id }, SUMMARIES);

    const text = JSON.stringify(await resolveSlug(dependencies, { accountId: ME, slug: "mail" }));

    expect(text).not.toContain("https://");
  });
});
