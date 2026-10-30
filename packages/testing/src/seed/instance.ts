import { BOOKMARK_SHAPE_NAMES, buildBookmarks, type SeedBookmark } from "./bookmarks.ts";
import { createIds, createRandom } from "./random.ts";

// The demo instance of `pnpm db:seed` (doc 08 section 1.3 and 1.4), as plain data. Nothing here touches a database:
// the same factories give the seed script its rows and the browser journeys their fixtures.

/** The fixed seed of the random source: the instance is the same on every run. */
export const DEMO_SEED = 20_260_115;
/** The moment the seed treats as now. */
export const DEMO_NOW = new Date(Date.UTC(2026, 0, 15, 12));
/** Bookmarks of the demo workspace. */
export const DEMO_BOOKMARK_COUNT = 300;
/** Bookmarks of the large workspace. */
export const LARGE_BOOKMARK_COUNT = 5_000;

export type SeedAccountKey = "admin" | "member";

export interface SeedAccount {
  readonly key: SeedAccountKey;
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly isInstanceAdmin: boolean;
}

/** A folder of the seed, with the bookmarks filed in it and the accounts it is shared with (doc 02 section 8). */
export interface SeedFolder {
  readonly id: string;
  readonly owner: SeedAccountKey;
  readonly name: string;
  readonly bookmarkIds: readonly string[];
  readonly shares: readonly { readonly id: string; readonly target: SeedAccountKey }[];
}

/** A bookmark shared with one account directly. */
export interface SeedBookmarkShare {
  readonly id: string;
  readonly bookmarkId: string;
  readonly granted: SeedAccountKey;
  readonly target: SeedAccountKey;
}

export interface SeedWorkspace {
  readonly id: string;
  readonly name: string;
  /** The account that creates and owns the workspace. */
  readonly owner: SeedAccountKey;
  /** The other accounts that are members of it. */
  readonly members: readonly { readonly account: SeedAccountKey; readonly role: "admin" | "member" }[];
  readonly bookmarks: readonly SeedBookmark[];
  readonly folders: readonly SeedFolder[];
  readonly bookmarkShares: readonly SeedBookmarkShare[];
}

export interface DemoInstance {
  readonly accounts: readonly SeedAccount[];
  readonly workspaces: readonly SeedWorkspace[];
}

export interface DemoInstanceOptions {
  readonly seed?: number;
  readonly demoBookmarks?: number;
  readonly largeBookmarks?: number;
}

/**
 * Two accounts (an instance admin and a member), the demo workspace of about 300 bookmarks that both of them use, and
 * a workspace of 5 000 that the admin owns. The bookmark rows carry every shape that breaks a UI (see `bookmarks.ts`).
 */
export function buildDemoInstance(options: DemoInstanceOptions = {}): DemoInstance {
  const random = createRandom(options.seed ?? DEMO_SEED);
  const ids = createIds(random, DEMO_NOW.getTime() - 400 * 86_400_000);
  const accounts: readonly SeedAccount[] = [
    { key: "admin", id: ids(), email: "admin@example.test", displayName: "Demo Admin", isInstanceAdmin: true },
    { key: "member", id: ids(), email: "member@example.test", displayName: "Demo Member", isInstanceAdmin: false },
  ];
  const [admin, member] = accounts;
  if (admin === undefined || member === undefined) {
    throw new Error("the demo instance has two accounts");
  }
  const demoId = ids();
  const largeId = ids();
  const demoBookmarks = buildBookmarks(options.demoBookmarks ?? DEMO_BOOKMARK_COUNT, { random, ids, owners: [admin.id, member.id], now: DEMO_NOW });
  const largeBookmarks = buildBookmarks(options.largeBookmarks ?? LARGE_BOOKMARK_COUNT, { random, ids, owners: [admin.id], now: DEMO_NOW });
  const go = withSlugs(demoBookmarks, { admin: admin.id, member: member.id }, ids);
  return {
    accounts,
    workspaces: [
      {
        id: demoId,
        name: "Demo workspace",
        owner: "admin",
        members: [{ account: "member", role: "member" }],
        bookmarks: go.bookmarks,
        folders: go.folders,
        bookmarkShares: go.bookmarkShares,
      },
      {
        id: largeId,
        name: "Large workspace",
        owner: "admin",
        members: [],
        bookmarks: largeBookmarks,
        folders: [],
        bookmarkShares: [],
      },
    ],
  };
}

/** The slugs the demo workspace gives its filler bookmarks: `docs`, `mail`, `wiki` and `standup`, of which the first three exist for both members (doc 02 sections 6.2 and 6.3). */
const ADMIN_SLUGS = ["docs", "mail", "wiki", "standup"] as const;
const MEMBER_SLUGS = ["docs", "mail", "wiki"] as const;

/**
 * Gives the first filler bookmarks of each account slugs that collide across the two members, and shares some of the admin's with the member: `docs`, `mail` and `wiki` are both members' own
 * (each resolves their own), the admin's `mail` and `standup` are filed in the folder "Team links" shared with the member, and the admin's `wiki` is shared with the member directly, so the member's
 * `standup` resolves to the one shared bookmark and their `mail` and `wiki` to their own while a shared one exists. A workspace too small to hold the filler gets what fits.
 */
function withSlugs(
  bookmarks: readonly SeedBookmark[],
  owners: Readonly<Record<SeedAccountKey, string>>,
  ids: () => string,
): { bookmarks: readonly SeedBookmark[]; folders: readonly SeedFolder[]; bookmarkShares: readonly SeedBookmarkShare[] } {
  const filler = bookmarks.slice(BOOKMARK_SHAPE_NAMES.length);
  const slugged = new Map<string, string>();
  const chosen: Record<SeedAccountKey, Map<string, string>> = { admin: new Map(), member: new Map() };
  for (const [key, slugs] of [["admin", ADMIN_SLUGS], ["member", MEMBER_SLUGS]] as const) {
    const mine = filler.filter((bookmark) => bookmark.ownerId === owners[key]);
    slugs.forEach((slug, index) => {
      const bookmark = mine[index];
      if (bookmark !== undefined) {
        slugged.set(bookmark.id, slug);
        chosen[key].set(slug, bookmark.id);
      }
    });
  }
  const teamLinks = ["mail", "standup"].flatMap((slug) => chosen.admin.get(slug) ?? []);
  const wiki = chosen.admin.get("wiki");
  return {
    bookmarks: bookmarks.map((bookmark) => {
      const slug = slugged.get(bookmark.id);
      return slug === undefined ? bookmark : { ...bookmark, slug, forwarding: true };
    }),
    folders: teamLinks.length === 0 ? [] : [{ id: ids(), owner: "admin", name: "Team links", bookmarkIds: teamLinks, shares: [{ id: ids(), target: "member" }] }],
    bookmarkShares: wiki === undefined ? [] : [{ id: ids(), bookmarkId: wiki, granted: "admin", target: "member" }],
  };
}
