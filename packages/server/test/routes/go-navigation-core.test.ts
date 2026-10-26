import { describe, expect, it } from "vitest";
import { navigateToSlug, type GoAccess, type GoBookmarkSummary, type GoCandidate } from "@slugbase/core";

// What a navigation to /go/<slug> is answered with (doc 02 section 6.2, doc 04 section 9.3, doc 10 T12): the address to forward to for one bookmark, the
// choice for several, nothing for the rest, and one use counted only when an address is answered.

const ME = "0192f3a0-bbbb-7000-8000-00000000000a";
const ANN = "0192f3a0-bbbb-7000-8000-00000000000b";

function candidate(n: number, ownerId: string, access: GoAccess, url: string): GoCandidate {
  return { id: `0192f3a0-aaaa-7000-8000-00000000000${String(n)}`, ownerId, url, access };
}

function summary(entry: GoCandidate): GoBookmarkSummary {
  return { id: entry.id, title: `Bookmark ${entry.id.slice(-1)}`, host: "example.com", ownerId: entry.ownerId, ownerName: "Someone" };
}

function navigating(candidates: readonly GoCandidate[], preferredId?: string) {
  const events: string[] = [];
  return {
    events,
    dependencies: {
      store: {
        candidates: () => Promise.resolve({ candidates, preferredId }),
        summaries: (ids: readonly string[]) => Promise.resolve(candidates.filter((entry) => ids.includes(entry.id)).map(summary)),
        remember: () => {
          events.push("remember");
          return Promise.resolve(true);
        },
      },
      usage: { record: (bookmarkId: string) => void events.push(`use ${bookmarkId}`) },
    },
  };
}

describe("navigateToSlug", () => {
  it("forwards to the caller's own bookmark and counts one use of it", async () => {
    const mine = candidate(1, ME, "owner", "https://example.com/mail");
    const { dependencies, events } = navigating([mine]);

    expect(await navigateToSlug(dependencies, { accountId: ME, slug: " Mail " })).toEqual({ kind: "forward", url: "https://example.com/mail" });
    expect(events).toEqual([`use ${mine.id}`]);
  });

  it("forwards to the remembered choice rather than the caller's own bookmark, and never remembers anything itself", async () => {
    const mine = candidate(1, ME, "owner", "https://example.com/mine");
    const theirs = candidate(2, ANN, "direct", "https://example.com/theirs");
    const { dependencies, events } = navigating([mine, theirs], theirs.id);

    expect(await navigateToSlug(dependencies, { accountId: ME, slug: "mail" })).toEqual({ kind: "forward", url: "https://example.com/theirs" });
    expect(events).toEqual([`use ${theirs.id}`]);
  });

  it("forwards to the one bookmark shared with the caller", async () => {
    const shared = candidate(2, ANN, "team", "http://example.com/shared");
    const { dependencies } = navigating([shared]);

    expect(await navigateToSlug(dependencies, { accountId: ME, slug: "mail" })).toEqual({ kind: "forward", url: "http://example.com/shared" });
  });

  it("leaves several shared bookmarks to the caller to choose from, counting nothing", async () => {
    const { dependencies, events } = navigating([candidate(2, ANN, "direct", "https://example.com/a"), candidate(3, ANN, "folder", "https://example.com/b")]);

    expect(await navigateToSlug(dependencies, { accountId: ME, slug: "mail" })).toEqual({ kind: "choose" });
    expect(events).toEqual([]);
  });

  it("is not_found for a slug nothing resolves to and for a slug outside the grammar, asking the store nothing for the latter", async () => {
    const { dependencies, events } = navigating([]);
    let asked = 0;
    const counting = { ...dependencies, store: { ...dependencies.store, candidates: () => { asked += 1; return Promise.resolve({ candidates: [], preferredId: undefined }); } } };

    expect(await navigateToSlug(counting, { accountId: ME, slug: "mail" })).toEqual({ kind: "not_found" });
    expect(asked).toBe(1);
    for (const slug of ["", "  ", "-mail", "ma il", "mail/inbox", "mail?x=1", "a".repeat(65)]) {
      expect(await navigateToSlug(counting, { accountId: ME, slug }), JSON.stringify(slug)).toEqual({ kind: "not_found" });
    }
    expect(asked).toBe(1);
    expect(events).toEqual([]);
  });

  it.each(["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "vbscript:x", "ftp://example.com/x", "//example.com/x", "http://exa mple.com/"])(
    "never forwards to the stored address %s, counts nothing and says only that nothing is found",
    async (url) => {
      const mine = candidate(1, ME, "owner", url);
      const { dependencies, events } = navigating([mine]);

      expect(await navigateToSlug(dependencies, { accountId: ME, slug: "mail" })).toEqual({ kind: "not_found" });
      expect(events).toEqual([]);
    },
  );
});
