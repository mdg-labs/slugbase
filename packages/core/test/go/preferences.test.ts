import { describe, expect, it } from "vitest";
import { forgetGoPreference, listGoPreferences, type GoPreferenceCursors, type GoPreferenceRecord } from "../../src/index.ts";

// The list and the forgetting of the remembered go choices (doc 02 section 6.4, doc 04 sections 6.1 and 10.3). The store decides which choices are the member's and
// which are still candidates; these tests give the services what a store would answer.

const ME = "0192f3a0-bbbb-7000-8000-00000000000a";
const ANN = "0192f3a0-bbbb-7000-8000-00000000000b";
const WORKSPACE = "0192f3a0-cccc-7000-8000-000000000001";

function record(slug: string, ownerId: string | null = ME, ownerName: string | null = "Me"): GoPreferenceRecord {
  return { slug, bookmarkId: `0192f3a0-aaaa-7000-8000-${slug.padStart(12, "0")}`, title: `Title ${slug}`, host: "example.com", ownerId, ownerName };
}

const CURSORS: GoPreferenceCursors = {
  seal: (afterSlug, scope) => `${scope}|${afterSlug}`,
  open: (cursor, scope) => (cursor.startsWith(`${scope}|`) ? cursor.slice(scope.length + 1) : undefined),
};

function listing(records: readonly GoPreferenceRecord[]) {
  const asked: { accountId: string; afterSlug: string | undefined; limit: number }[] = [];
  return {
    asked,
    dependencies: {
      cursors: CURSORS,
      store: {
        listPreferences: (request: { accountId: string; afterSlug: string | undefined; limit: number }) => {
          asked.push(request);
          return Promise.resolve(records.filter((entry) => request.afterSlug === undefined || entry.slug > request.afterSlug).slice(0, request.limit));
        },
      },
    },
  };
}

describe("listGoPreferences", () => {
  it("names the slug, the bookmark, its title and host, and no owner for the member's own bookmark", async () => {
    const { dependencies } = listing([record("mail")]);

    expect(await listGoPreferences(dependencies, { workspaceId: WORKSPACE, accountId: ME, limit: 50, cursor: undefined })).toEqual({
      kind: "listed",
      items: [{ slug: "mail", bookmarkId: record("mail").bookmarkId, title: "Title mail", host: "example.com", owner: null }],
      nextCursor: null,
    });
  });

  it("names the owner of a bookmark of another member, and none for one whose owner has left", async () => {
    const { dependencies } = listing([record("a", ANN, "Ann"), record("b", null, null)]);

    const outcome = await listGoPreferences(dependencies, { workspaceId: WORKSPACE, accountId: ME.toUpperCase(), limit: 50, cursor: undefined });

    expect(outcome.kind === "listed" ? outcome.items.map((item) => item.owner) : []).toEqual([{ accountId: ANN, displayName: "Ann" }, null]);
  });

  it("never names an address", async () => {
    const { dependencies } = listing([record("mail")]);

    const text = JSON.stringify(await listGoPreferences(dependencies, { workspaceId: WORKSPACE, accountId: ME, limit: 50, cursor: undefined }));

    expect(text).not.toContain("https://");
  });

  it("pages by the slug: a full page carries the cursor that resumes after its last slug, and the last page none", async () => {
    const { asked, dependencies } = listing([record("a"), record("b"), record("c")]);

    const first = await listGoPreferences(dependencies, { workspaceId: WORKSPACE, accountId: ME, limit: 2, cursor: undefined });
    expect(first.kind === "listed" ? first.items.map((item) => item.slug) : []).toEqual(["a", "b"]);
    const cursor = first.kind === "listed" ? (first.nextCursor ?? undefined) : undefined;
    expect(cursor).toBeDefined();
    const second = await listGoPreferences(dependencies, { workspaceId: WORKSPACE, accountId: ME, limit: 2, cursor });

    expect(second).toMatchObject({ kind: "listed", items: [{ slug: "c" }], nextCursor: null });
    expect(asked).toEqual([
      { accountId: ME, afterSlug: undefined, limit: 3 },
      { accountId: ME, afterSlug: "b", limit: 3 },
    ]);
  });

  it("has no next page when the page holds exactly the rest", async () => {
    const { dependencies } = listing([record("a"), record("b")]);

    expect(await listGoPreferences(dependencies, { workspaceId: WORKSPACE, accountId: ME, limit: 2, cursor: undefined })).toMatchObject({ nextCursor: null });
  });

  it("refuses, reading nothing, a cursor of another account or another workspace and one that holds no slug", async () => {
    const { asked, dependencies } = listing([record("a"), record("b")]);
    const issued = CURSORS.seal("a", JSON.stringify([WORKSPACE, ANN]));
    const elsewhere = CURSORS.seal("a", JSON.stringify(["0192f3a0-cccc-7000-8000-000000000002", ME]));
    const notASlug = CURSORS.seal("Not A Slug", JSON.stringify([WORKSPACE, ME]));

    for (const cursor of [issued, elsewhere, notASlug, "garbage"]) {
      expect(await listGoPreferences(dependencies, { workspaceId: WORKSPACE, accountId: ME, limit: 2, cursor })).toEqual({ kind: "bad_cursor" });
    }
    expect(asked).toEqual([]);
  });
});

describe("forgetGoPreference", () => {
  function forgetting(answer: boolean) {
    const asked: { slug: string; accountId: string }[] = [];
    return {
      asked,
      dependencies: {
        store: {
          forgetPreference: (request: { slug: string; accountId: string }) => {
            asked.push(request);
            return Promise.resolve(answer);
          },
        },
      },
    };
  }

  it("trims and lower-cases the slug and the account before it asks the store, and answers what it did", async () => {
    const gone = forgetting(true);
    const none = forgetting(false);

    expect(await forgetGoPreference(gone.dependencies, { accountId: ME.toUpperCase(), slug: "  Mail " })).toBe(true);
    expect(await forgetGoPreference(none.dependencies, { accountId: ME, slug: "mail" })).toBe(false);
    expect(gone.asked).toEqual([{ slug: "mail", accountId: ME }]);
  });

  it("answers false, without asking the store, for a slug outside the grammar", async () => {
    const { asked, dependencies } = forgetting(true);

    for (const slug of ["", "  ", "-mail", "a b", "ä", "a".repeat(65)]) {
      expect(await forgetGoPreference(dependencies, { accountId: ME, slug }), JSON.stringify(slug)).toBe(false);
    }
    expect(asked).toEqual([]);
  });
});
