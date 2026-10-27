import type { TagStore } from "../tags/create.ts";

// The dashboard of a member (doc 02 section 9.3, doc 04 section 10.8, doc 10 T1 and T2): the member's own counts, their most used slugs, their pinned bookmarks and their most used tags
// in the active workspace, and the state of the Getting started checklist. Every read names the account of the transaction as the owner, so another member's bookmark, folder or tag and
// anything of another workspace is never in an answer, and plan-archived bookmarks are neither counted nor listed. Sharing does not exist yet: the count of bookmarks shared with the
// member and the sharing block are null until it does.

/** The most bookmarks the quick access holds. */
export const DASHBOARD_QUICK_ACCESS_LIMIT = 8;

/** The most pinned bookmarks the dashboard holds. */
export const DASHBOARD_PINNED_LIMIT = 12;

/** The most tags the dashboard holds. */
export const DASHBOARD_TOP_TAGS_LIMIT = 12;

/** A bookmark as the dashboard shows it: never its owner, its version or its dates. */
export interface DashboardBookmark {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly host: string;
  readonly slug: string | null;
  readonly forwarding: boolean;
  readonly openCount: number;
}

/** What the data says of the member, in one read. */
export interface DashboardSummary {
  /** The member's bookmarks that are not plan-archived. */
  readonly bookmarks: number;
  readonly folders: number;
  readonly tags: number;
  /** Whether the member owns a bookmark, plan-archived ones included: adding one is done once it was added. */
  readonly hasBookmark: boolean;
  /** Whether one of the member's bookmarks has a slug, plan-archived ones included. */
  readonly hasSlug: boolean;
}

/** The checklist state an account stores itself; the other items are derived from data. */
export interface StoredOnboarding {
  readonly browserSetupDone: boolean;
  readonly importDone: boolean;
  readonly checklistDismissed: boolean;
}

export interface DashboardStore {
  /** The counts and the derived checklist facts of `ownerId` in the workspace of the transaction. */
  summary(ownerId: string): Promise<DashboardSummary>;
  /** At most `limit` of the bookmarks `ownerId` owns and can read that forward by a slug and are not plan-archived, the most opened first, then by identifier. */
  quickAccess(ownerId: string, limit: number): Promise<readonly DashboardBookmark[]>;
  /** At most `limit` of the not plan-archived bookmarks `ownerId` owns and pinned, the most recently pinned first, then by identifier. */
  pinned(ownerId: string, limit: number): Promise<readonly DashboardBookmark[]>;
  /** The onboarding state stored on the account `ownerId`; undefined when the account has no row. */
  onboarding(ownerId: string): Promise<StoredOnboarding | undefined>;
}

export interface DashboardDependencies {
  readonly store: DashboardStore;
  readonly tags: Pick<TagStore, "list">;
}

export interface DashboardAsk {
  /** The member whose dashboard it is; the account of the transaction. */
  readonly accountId: string;
}

export interface Dashboard {
  readonly counts: { readonly bookmarks: number; readonly folders: number; readonly tags: number; readonly sharedWithYou: number | null };
  readonly quickAccess: readonly DashboardBookmark[];
  readonly pinned: readonly DashboardBookmark[];
  readonly topTags: readonly { readonly id: string; readonly name: string; readonly bookmarkCount: number }[];
  readonly sharing: { readonly sharedWithYou: number; readonly sharedByYou: number } | null;
  readonly onboarding: {
    readonly bookmarkAdded: boolean;
    readonly slugGiven: boolean;
    readonly browserSetupDone: boolean;
    readonly folderCreated: boolean;
    readonly importDone: boolean;
    readonly dismissed: boolean;
  };
}

/** The dashboard of the member; undefined when the account has no row any more, which is an account deleted while the request ran. */
export async function dashboard({ store, tags }: DashboardDependencies, ask: DashboardAsk): Promise<Dashboard | undefined> {
  const ownerId = ask.accountId.toLowerCase();
  // One after the other: the reads share the one connection of the transaction.
  const summary = await store.summary(ownerId);
  const quickAccess = await store.quickAccess(ownerId, DASHBOARD_QUICK_ACCESS_LIMIT);
  const pinned = await store.pinned(ownerId, DASHBOARD_PINNED_LIMIT);
  const topTags = await tags.list({ ownerId, sort: "count", after: undefined, limit: DASHBOARD_TOP_TAGS_LIMIT });
  const stored = await store.onboarding(ownerId);
  if (stored === undefined) {
    return undefined;
  }
  return {
    counts: { bookmarks: summary.bookmarks, folders: summary.folders, tags: summary.tags, sharedWithYou: null },
    quickAccess,
    pinned,
    topTags: topTags.map(({ id, name, bookmarkCount }) => ({ id, name, bookmarkCount })),
    sharing: null,
    onboarding: {
      bookmarkAdded: summary.hasBookmark,
      slugGiven: summary.hasSlug,
      browserSetupDone: stored.browserSetupDone,
      folderCreated: summary.folders > 0,
      importDone: stored.importDone,
      dismissed: stored.checklistDismissed,
    },
  };
}
