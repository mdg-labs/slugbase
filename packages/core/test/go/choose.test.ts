import { describe, expect, it } from "vitest";
import { chooseSlugBookmark, type GoCandidate } from "../../src/index.ts";

// Choosing a candidate of a slug (doc 04 section 10.8): the bookmark has to be a current candidate for the caller, the destination is checked again, the
// choice is written only when asked and only for a candidate, and the use is counted last.

const ME = "0192f3a0-bbbb-7000-8000-00000000000a";
const MINE = "0192f3a0-aaaa-7000-8000-000000000001";
const OTHERS = "0192f3a0-aaaa-7000-8000-000000000002";

function candidate(id: string, url: string): GoCandidate {
  return { id, ownerId: ME, url, access: "owner" };
}

function choosing(candidates: readonly GoCandidate[], options: { remembers?: boolean } = {}) {
  const events: string[] = [];
  const asked: { slug: string; accountId: string }[] = [];
  return {
    events,
    asked,
    dependencies: {
      store: {
        candidates: (request: { slug: string; accountId: string }) => {
          asked.push(request);
          return Promise.resolve({ candidates, preferredId: undefined });
        },
        summaries: () => Promise.resolve([]),
        remember: (request: { slug: string; bookmarkId: string; accountId: string }) => {
          events.push(`remember ${request.slug} ${request.bookmarkId} ${request.accountId}`);
          return Promise.resolve(options.remembers ?? true);
        },
      },
      usage: { record: (bookmarkId: string) => void events.push(`use ${bookmarkId}`) },
    },
  };
}

describe("chooseSlugBookmark", () => {
  it("answers the destination of a candidate and counts one use of it, remembering nothing unless asked", async () => {
    const { dependencies, events } = choosing([candidate(MINE, "https://example.com/docs")]);

    const outcome = await chooseSlugBookmark(dependencies, { accountId: ME, slug: " Mail ", bookmarkId: MINE, remember: false });

    expect(outcome).toEqual({ kind: "chosen", url: "https://example.com/docs" });
    expect(events).toEqual([`use ${MINE}`]);
  });

  it("remembers the choice for the slug in its normal form, then counts the use", async () => {
    const { dependencies, events, asked } = choosing([candidate(MINE, "https://example.com/docs")]);

    const outcome = await chooseSlugBookmark(dependencies, { accountId: ME.toUpperCase(), slug: " Mail ", bookmarkId: MINE.toUpperCase(), remember: true });

    expect(outcome).toEqual({ kind: "chosen", url: "https://example.com/docs" });
    expect(asked).toEqual([{ slug: "mail", accountId: ME }]);
    expect(events).toEqual([`remember mail ${MINE} ${ME}`, `use ${MINE}`]);
  });

  it("is not_found for a bookmark that is not among the candidates, writing and counting nothing", async () => {
    const { dependencies, events } = choosing([candidate(MINE, "https://example.com/docs")]);

    expect(await chooseSlugBookmark(dependencies, { accountId: ME, slug: "mail", bookmarkId: OTHERS, remember: true })).toEqual({ kind: "not_found" });
    expect(events).toEqual([]);
  });

  it("is not_found for a slug outside the grammar without asking the store", async () => {
    const { dependencies, events, asked } = choosing([candidate(MINE, "https://example.com/docs")]);

    expect(await chooseSlugBookmark(dependencies, { accountId: ME, slug: "not a slug", bookmarkId: MINE, remember: true })).toEqual({ kind: "not_found" });
    expect(asked).toEqual([]);
    expect(events).toEqual([]);
  });

  it("is not_found, counting nothing, when the choice cannot be remembered because the bookmark stopped being a candidate", async () => {
    const { dependencies, events } = choosing([candidate(MINE, "https://example.com/docs")], { remembers: false });

    expect(await chooseSlugBookmark(dependencies, { accountId: ME, slug: "mail", bookmarkId: MINE, remember: true })).toEqual({ kind: "not_found" });
    expect(events).toEqual([`remember mail ${MINE} ${ME}`]);
  });

  it.each(["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "file:///etc/passwd", "//example.com/path", "ftp://example.com/file", ""])(
    "checks the stored URL again and refuses %j before it remembers or counts anything",
    async (url) => {
      const { dependencies, events } = choosing([candidate(MINE, url)]);

      expect(await chooseSlugBookmark(dependencies, { accountId: ME, slug: "mail", bookmarkId: MINE, remember: true })).toEqual({ kind: "url_refused" });
      expect(events).toEqual([]);
    },
  );

  it("passes a failure of the store on, counting nothing", async () => {
    const { dependencies, events } = choosing([candidate(MINE, "https://example.com/docs")]);
    const failing = { ...dependencies, store: { ...dependencies.store, remember: () => Promise.reject(new Error("the database is down")) } };

    await expect(chooseSlugBookmark(failing, { accountId: ME, slug: "mail", bookmarkId: MINE, remember: true })).rejects.toThrow("the database is down");
    expect(events).toEqual([]);
  });
});
