import { buildBookmarks, type SeedBookmark } from "./bookmarks.ts";
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

export interface SeedWorkspace {
  readonly id: string;
  readonly name: string;
  /** The account that creates and owns the workspace. */
  readonly owner: SeedAccountKey;
  /** The other accounts that are members of it. */
  readonly members: readonly { readonly account: SeedAccountKey; readonly role: "admin" | "member" }[];
  readonly bookmarks: readonly SeedBookmark[];
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
  return {
    accounts,
    workspaces: [
      {
        id: demoId,
        name: "Demo workspace",
        owner: "admin",
        members: [{ account: "member", role: "member" }],
        bookmarks: buildBookmarks(options.demoBookmarks ?? DEMO_BOOKMARK_COUNT, { random, ids, owners: [admin.id, member.id], now: DEMO_NOW }),
      },
      {
        id: largeId,
        name: "Large workspace",
        owner: "admin",
        members: [],
        bookmarks: buildBookmarks(options.largeBookmarks ?? LARGE_BOOKMARK_COUNT, { random, ids, owners: [admin.id], now: DEMO_NOW }),
      },
    ],
  };
}
