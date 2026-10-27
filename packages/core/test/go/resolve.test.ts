import { describe, expect, it } from "vitest";
import { GO_OTHER_WORKSPACES_MAX, resolveInWorkspace, resolveSlug, type GoAccess, type GoBookmarkSummary, type GoCandidate, type GoCandidateSet, type GoWorkspace } from "../../src/index.ts";

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

function store(found: GoCandidateSet, summaries: readonly GoBookmarkSummary[], others: readonly GoWorkspace[] = []) {
  const asked: { slug: string; accountId: string }[] = [];
  const askedOthers: { slug: string; accountId: string }[] = [];
  const forgotten: { slug: string; bookmarkId: string; accountId: string }[] = [];
  return {
    asked,
    askedOthers,
    forgotten,
    dependencies: {
      store: {
        otherWorkspaces: (request: { slug: string; accountId: string }) => {
          askedOthers.push(request);
          return Promise.resolve(others);
        },
        candidates: (request: { slug: string; accountId: string }) => {
          asked.push(request);
          return Promise.resolve(found);
        },
        summaries: (ids: readonly string[]) => Promise.resolve(summaries.filter((entry) => ids.includes(entry.id))),
        forgetStale: (request: { slug: string; bookmarkId: string; accountId: string }) => {
          forgotten.push(request);
          return Promise.resolve(true);
        },
      },
    },
  };
}

const MINE = candidate("0192f3a0-aaaa-7000-8000-000000000001", ME);
const ANNS = candidate("0192f3a0-aaaa-7000-8000-000000000002", ANN);
const BENS = candidate("0192f3a0-aaaa-7000-8000-000000000003", BEN, "team");
const WORK: GoWorkspace = { id: "0192f3a0-dddd-7000-8000-000000000001", name: "Work" };
const HOME: GoWorkspace = { id: "0192f3a0-dddd-7000-8000-000000000002", name: "Home" };
const SUMMARIES = [
  summary(MINE.id, "My mail", ME, "Me"),
  summary(ANNS.id, "Ann's mail", ANN, "Ann"),
  summary(BENS.id, "ben's mail", BEN, "Ben"),
];

describe("resolveSlug", () => {
  it("names the other workspaces the store finds for a slug that resolves to nothing, asked with the normalised slug and account", async () => {
    const { askedOthers, dependencies } = store({ candidates: [], preferredId: undefined }, [], [HOME, WORK]);

    expect(await resolveSlug(dependencies, { accountId: ME.toUpperCase(), slug: "  Mail  " })).toEqual({ kind: "none", otherWorkspaces: [HOME, WORK] });
    expect(askedOthers).toEqual([{ slug: "mail", accountId: ME }]);
  });

  it("names the other workspaces when the only candidates were deleted between the two reads", async () => {
    const { dependencies } = store({ candidates: [MINE], preferredId: undefined }, [], [WORK]);

    expect(await resolveSlug(dependencies, { accountId: ME, slug: "mail" })).toEqual({ kind: "none", otherWorkspaces: [WORK] });
  });

  it("names at most twenty other workspaces, whatever the store answers", async () => {
    const many = Array.from({ length: GO_OTHER_WORKSPACES_MAX + 5 }, (_, index) => ({ id: `0192f3a0-dddd-7000-8000-0000000001${String(index).padStart(2, "0")}`, name: `W${String(index)}` }));
    const { dependencies } = store({ candidates: [], preferredId: undefined }, [], many);

    const resolution = await resolveSlug(dependencies, { accountId: ME, slug: "mail" });

    expect(resolution.kind === "none" ? resolution.otherWorkspaces : []).toEqual(many.slice(0, GO_OTHER_WORKSPACES_MAX));
  });

  it("asks about other workspaces only for a miss, never when a bookmark resolves", async () => {
    const own = store({ candidates: [MINE], preferredId: undefined }, SUMMARIES, [WORK]);
    const preferred = store({ candidates: [MINE, ANNS], preferredId: ANNS.id }, SUMMARIES, [WORK]);
    const several = store({ candidates: [ANNS, BENS], preferredId: undefined }, SUMMARIES, [WORK]);

    await resolveSlug(own.dependencies, { accountId: ME, slug: "mail" });
    await resolveSlug(preferred.dependencies, { accountId: ME, slug: "mail" });
    await resolveSlug(several.dependencies, { accountId: ME, slug: "mail" });

    expect([own.askedOthers, preferred.askedOthers, several.askedOthers]).toEqual([[], [], []]);
  });

  it("lets a failure of the lookup of other workspaces fail the resolution, as nothing turns it into an empty list", async () => {
    const { dependencies } = store({ candidates: [], preferredId: undefined }, []);
    const failing = { store: { ...dependencies.store, otherWorkspaces: () => Promise.reject(new Error("lookup failed")) } };

    await expect(resolveSlug(failing, { accountId: ME, slug: "mail" })).rejects.toThrow("lookup failed");
  });

  it("is none for a slug nobody the caller can read has", async () => {
    const { dependencies } = store({ candidates: [], preferredId: undefined }, []);

    expect(await resolveSlug(dependencies, { accountId: ME, slug: "mail" })).toEqual({ kind: "none", otherWorkspaces: [] });
  });

  it("is none, without asking the store, for a slug outside the grammar", async () => {
    const { asked, askedOthers, dependencies } = store({ candidates: [MINE], preferredId: undefined }, SUMMARIES, [WORK]);

    for (const slug of ["", "   ", "-mail", "a b", "mail/", "mail?x=1", "ä", "a".repeat(65)]) {
      expect(await resolveSlug(dependencies, { accountId: ME, slug }), JSON.stringify(slug)).toEqual({ kind: "none", otherWorkspaces: [] });
    }
    expect(asked).toEqual([]);
    expect(askedOthers).toEqual([]);
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
    expect(await resolveSlug(nothingLeft.dependencies, { accountId: ME, slug: "mail" })).toEqual({ kind: "none", otherWorkspaces: [] });
    expect(await resolveSlug(oneLeft.dependencies, { accountId: ME, slug: "mail" })).toMatchObject({ kind: "single", bookmark: { id: BENS.id } });
  });

  it("never names an address", async () => {
    const { dependencies } = store({ candidates: [MINE], preferredId: MINE.id }, SUMMARIES);

    const text = JSON.stringify(await resolveSlug(dependencies, { accountId: ME, slug: "mail" }));

    expect(text).not.toContain("https://");
  });

  describe("a remembered choice that is no candidate", () => {
    it("is ignored, asked to be forgotten with the account and the slug, and the caller's own bookmark resolves", async () => {
      const { dependencies, forgotten } = store({ candidates: [MINE], preferredId: ANNS.id }, SUMMARIES);

      expect(await resolveSlug(dependencies, { accountId: ME, slug: "Mail" })).toMatchObject({ kind: "single", bookmark: { id: MINE.id } });
      expect(forgotten).toEqual([{ slug: "mail", bookmarkId: ANNS.id, accountId: ME }]);
    });

    it("is asked to be forgotten when no bookmark has the slug at all, which resolves to none", async () => {
      const { dependencies, forgotten } = store({ candidates: [], preferredId: ANNS.id }, []);

      expect(await resolveSlug(dependencies, { accountId: ME, slug: "mail" })).toEqual({ kind: "none", otherWorkspaces: [] });
      expect(forgotten).toEqual([{ slug: "mail", bookmarkId: ANNS.id, accountId: ME }]);
    });

    it("is asked to be forgotten when its candidate was deleted between the two reads", async () => {
      const { dependencies, forgotten } = store({ candidates: [MINE, ANNS], preferredId: ANNS.id }, [SUMMARIES[0] as GoBookmarkSummary]);

      await resolveSlug(dependencies, { accountId: ME, slug: "mail" });

      expect(forgotten).toEqual([{ slug: "mail", bookmarkId: ANNS.id, accountId: ME }]);
    });

    it("is not asked about when the choice is a candidate, or when there is no choice", async () => {
      const chosen = store({ candidates: [MINE, ANNS], preferredId: ANNS.id }, SUMMARIES);
      const none = store({ candidates: [MINE], preferredId: undefined }, SUMMARIES);

      await resolveSlug(chosen.dependencies, { accountId: ME, slug: "mail" });
      await resolveSlug(none.dependencies, { accountId: ME, slug: "mail" });

      expect(chosen.forgotten).toEqual([]);
      expect(none.forgotten).toEqual([]);
    });

    it("lets a failure of the store to forget it fail the resolution, as nothing hides it", async () => {
      const { dependencies } = store({ candidates: [MINE], preferredId: ANNS.id }, SUMMARIES);
      const failing = { store: { ...dependencies.store, forgetStale: () => Promise.reject(new Error("write failed")) } };

      await expect(resolveSlug(failing, { accountId: ME, slug: "mail" })).rejects.toThrow("write failed");
    });
  });
});

describe("resolveInWorkspace", () => {
  it("resolves in the workspace only and never asks about the other workspaces, also for a slug that resolves to nothing", async () => {
    const { askedOthers, dependencies } = store({ candidates: [], preferredId: undefined }, [], [WORK]);

    expect(await resolveInWorkspace(dependencies, { accountId: ME, slug: "mail" })).toEqual({ kind: "none" });
    expect(askedOthers).toEqual([]);
  });
});
