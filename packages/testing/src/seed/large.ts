import { buildBookmarks, type SeedBookmark } from "./bookmarks.ts";
import { DEMO_NOW } from "./instance.ts";
import { createIds, createRandom, type Random } from "./random.ts";

// The large instance of the performance suite (doc 08 section 5.3): 50 000 bookmarks in one workspace and 2 000 further
// workspaces, as plain data. Nothing here touches a database. The same seed gives the same instance on every run, so a
// change in a budget is a change in the code and not in the data.

/** The fixed seed of the random source. */
export const LARGE_INSTANCE_SEED = 20_260_301;
/** Bookmarks of the large workspace. */
export const PERF_BOOKMARK_COUNT = 50_000;
/** Workspaces besides the large one. */
export const PERF_EXTRA_WORKSPACES = 2_000;
/** Bookmarks of each further workspace. */
export const PERF_EXTRA_WORKSPACE_BOOKMARKS = 10;

/** Share of the bookmarks that carry a slug, and of those the share that /go forwards to. */
const SLUGGED_SHARE = 0.12;
const FORWARDING_SHARE = 0.85;
const TAGGED_SHARE = 0.4;
const FILED_SHARE = 0.35;
/** The owner of the large workspace holds eight in ten of its bookmarks, the two members the rest. */
const ADMIN_WEIGHT = 8;
/** How many of the owner's slugs the load scenarios resolve. */
const SLUG_SAMPLE = 200;
/** How many forwarding bookmarks each member shares with the owner by each route: directly, through a shared folder and through a shared team. */
const SHARED_PER_ROUTE = 40;
/** The slug that one member alone shares with the owner, and the slug that both members share with the owner, which the owner has not got as their own. */
const SHARED_SINGLE_SLUG = "perf-shared-one";
const SHARED_MANY_SLUG = "perf-shared-many";

const SLUG_WORDS = [
  "docs", "gh", "jira", "wiki", "mail", "cal", "drive", "notes", "ci", "logs", "metrics", "deploy", "status", "pr", "issues", "design",
  "roadmap", "standup", "oncall", "runbook", "billing", "admin", "home", "news", "music", "maps", "tasks", "board", "chat", "vpn",
  "hr", "travel", "recipes", "bank", "taxes", "gym", "reading", "learn", "api", "sdk", "blog", "play", "lab", "demo", "staging", "prod",
] as const;
const TAG_NAMES = [
  "work", "reading", "reference", "ideas", "later", "tools", "design", "code", "news", "recipes", "travel", "money", "health", "learning", "podcasts",
  "video", "research", "inspiration", "tutorial", "docs", "career", "home", "family", "music", "games", "science", "security", "writing", "data", "ops",
] as const;
const FOLDER_NAMES = ["Inbox", "Work", "Projects", "Reading list", "Reference", "Personal", "Recipes", "Travel", "Learning", "Archive", "Tools", "Ideas"] as const;
/** Text that the filler titles, the slugs, the tags and the folders carry, for the search scenario. */
const SEARCH_TERMS = ["caching", "accessibility", "release notes", "database indexes", "docs", "reading", "do"] as const;

export interface LargeAccount {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly isInstanceAdmin: boolean;
}

export interface LargeBookmark extends SeedBookmark {
  readonly slug: string | null;
  readonly forwarding: boolean;
}

export interface LargeNamed {
  readonly id: string;
  readonly ownerId: string;
  readonly name: string;
}

/** A team of the workspace and its members. */
export interface LargeTeam {
  readonly id: string;
  readonly name: string;
  readonly memberIds: readonly string[];
}

/** A grant of read access to a bookmark or a folder, to one account or one team. */
export interface LargeShare {
  readonly id: string;
  /** The bookmark or the folder. */
  readonly subjectId: string;
  readonly grantedBy: string;
  readonly accountId: string | null;
  readonly teamId: string | null;
}

export interface LargeWorkspace {
  readonly id: string;
  readonly name: string;
  readonly ownerId: string;
  /** The members besides the owner, who is a member as the creator. */
  readonly members: readonly { readonly accountId: string; readonly role: "admin" | "member" }[];
  readonly bookmarks: readonly LargeBookmark[];
  readonly tags: readonly LargeNamed[];
  readonly folders: readonly LargeNamed[];
  readonly bookmarkTags: readonly { readonly bookmarkId: string; readonly tagId: string }[];
  readonly folderBookmarks: readonly { readonly folderId: string; readonly bookmarkId: string }[];
  readonly teams: readonly LargeTeam[];
  readonly bookmarkShares: readonly LargeShare[];
  readonly folderShares: readonly LargeShare[];
}

/** What the load scenarios need to know about the instance; the account's password is made when the run starts. */
export interface PerfFixtures {
  readonly email: string;
  /** Slugs of the account that /go forwards to. */
  readonly slugs: readonly string[];
  readonly tagIds: readonly string[];
  readonly folderIds: readonly string[];
  readonly searchTerms: readonly string[];
  /** Slugs of the account that /go forwards to although others share a bookmark with the same slug: the account's own comes first. */
  readonly collidingSlugs: readonly string[];
  /** Slugs that only one member's bookmark, shared with the account, has: /go forwards to it. */
  readonly sharedSlugs: readonly string[];
  /** Slugs that several shared bookmarks have and the account has none: /go asks to choose. */
  readonly ambiguousSlugs: readonly string[];
  /** Search terms that only bookmarks shared with the account match. */
  readonly sharedSearchTerms: readonly string[];
}

export interface LargeInstance {
  readonly accounts: readonly LargeAccount[];
  readonly workspaces: readonly LargeWorkspace[];
  readonly fixtures: PerfFixtures;
}

export interface LargeInstanceOptions {
  readonly seed?: number;
  readonly bookmarks?: number;
  readonly workspaces?: number;
}

interface Population {
  readonly random: Random;
  readonly ids: () => string;
}

/** A slug of the owner that no other bookmark of theirs holds: a word of the list, then the word with a number. */
function slugger(random: Random): () => string {
  const taken = new Map<string, number>();
  return () => {
    const word = random.pick(SLUG_WORDS);
    const count = (taken.get(word) ?? 0) + 1;
    taken.set(word, count);
    return count === 1 ? word : `${word}-${String(count)}`;
  };
}

function populate(population: Population, workspace: { id: string; name: string; ownerId: string; members: LargeWorkspace["members"] }, owners: readonly string[], count: number, tagCount: number, folderCount: number): LargeWorkspace {
  const { random, ids } = population;
  const seeded = buildBookmarks(count, { random, ids, owners, now: DEMO_NOW });
  const slugs = new Map(owners.map((owner) => [owner, slugger(random)]));
  const bookmarks = seeded.map((bookmark): LargeBookmark => {
    const next = slugs.get(bookmark.ownerId);
    const slug = next !== undefined && random.chance(SLUGGED_SHARE) ? next() : null;
    return { ...bookmark, slug, forwarding: slug !== null && random.chance(FORWARDING_SHARE) };
  });
  const people = [...new Set(owners)];
  const tags = people.flatMap((ownerId) => TAG_NAMES.slice(0, tagCount).map((name): LargeNamed => ({ id: ids(), ownerId, name })));
  const folders = people.flatMap((ownerId) => FOLDER_NAMES.slice(0, folderCount).map((name): LargeNamed => ({ id: ids(), ownerId, name })));
  const bookmarkTags: { bookmarkId: string; tagId: string }[] = [];
  const folderBookmarks: { folderId: string; bookmarkId: string }[] = [];
  for (const bookmark of bookmarks) {
    const mine = tags.filter((tag) => tag.ownerId === bookmark.ownerId);
    if (mine.length > 0 && random.chance(TAGGED_SHARE)) {
      for (const tag of new Set([random.pick(mine), random.pick(mine), ...(random.chance(0.3) ? [random.pick(mine)] : [])])) {
        bookmarkTags.push({ bookmarkId: bookmark.id, tagId: tag.id });
      }
    }
    const kept = folders.filter((folder) => folder.ownerId === bookmark.ownerId);
    if (kept.length > 0 && random.chance(FILED_SHARE)) {
      folderBookmarks.push({ folderId: random.pick(kept).id, bookmarkId: bookmark.id });
    }
  }
  return { ...workspace, bookmarks, tags, folders, bookmarkTags, folderBookmarks, teams: [], bookmarkShares: [], folderShares: [] };
}

/** What `shareWithOwner` made of the workspace, and the slugs the scenarios resolve through the shares. */
interface Shared {
  readonly workspace: LargeWorkspace;
  readonly collidingSlugs: readonly string[];
  readonly sharedSlugs: readonly string[];
  readonly ambiguousSlugs: readonly string[];
}

/**
 * Each member shares forwarding bookmarks with the owner by every route, so the owner's `/go` meets shared candidates: the slugs of the members and of the owner come from the same words
 * (a slug is unique per owner, not per workspace), so the shared bookmarks collide with the owner's own, which win, and with each other. Of each member's forwarding bookmarks the first is given
 * `perf-shared-one` (the first member) or `perf-shared-many` (both members, and the owner has neither), shared directly; the next `SHARED_PER_ROUTE` are shared directly, the next
 * `SHARED_PER_ROUTE` are filed in a folder of the member shared with the owner, and the next `SHARED_PER_ROUTE` are shared with a team of the owner and both members.
 */
function shareWithOwner(large: LargeWorkspace, ownerId: string, memberIds: readonly string[], ids: () => string): Shared {
  const team: LargeTeam = { id: ids(), name: "Perf team", memberIds: [ownerId, ...memberIds] };
  const renamed = new Map<string, string>();
  const bookmarkShares: LargeShare[] = [];
  const folderShares: LargeShare[] = [];
  const folders: LargeNamed[] = [];
  const folderBookmarks: { folderId: string; bookmarkId: string }[] = [];
  const share = (subjectId: string, grantedBy: string, target: { accountId: string } | { teamId: string }): LargeShare => ({
    id: ids(),
    subjectId,
    grantedBy,
    accountId: "accountId" in target ? target.accountId : null,
    teamId: "teamId" in target ? target.teamId : null,
  });
  const colliding: string[] = [];
  const ownerSlugs = new Set(large.bookmarks.filter((bookmark) => bookmark.ownerId === ownerId && bookmark.forwarding).map((bookmark) => bookmark.slug));
  memberIds.forEach((memberId, index) => {
    const mine = large.bookmarks.filter((bookmark) => bookmark.ownerId === memberId && bookmark.forwarding && bookmark.slug !== null);
    const special = index === 0 ? [SHARED_SINGLE_SLUG, SHARED_MANY_SLUG] : [SHARED_MANY_SLUG];
    special.forEach((slug, at) => {
      const bookmark = mine[at];
      if (bookmark !== undefined) {
        renamed.set(bookmark.id, slug);
        bookmarkShares.push(share(bookmark.id, memberId, { accountId: ownerId }));
      }
    });
    const rest = mine.slice(special.length);
    for (const bookmark of rest.slice(0, SHARED_PER_ROUTE)) {
      bookmarkShares.push(share(bookmark.id, memberId, { accountId: ownerId }));
    }
    const filed = rest.slice(SHARED_PER_ROUTE, 2 * SHARED_PER_ROUTE);
    if (filed.length > 0) {
      const folder: LargeNamed = { id: ids(), ownerId: memberId, name: "Shared with Perf Admin" };
      folders.push(folder);
      folderShares.push(share(folder.id, memberId, { accountId: ownerId }));
      for (const bookmark of filed) {
        folderBookmarks.push({ folderId: folder.id, bookmarkId: bookmark.id });
      }
    }
    for (const bookmark of rest.slice(2 * SHARED_PER_ROUTE, 3 * SHARED_PER_ROUTE)) {
      bookmarkShares.push(share(bookmark.id, memberId, { teamId: team.id }));
    }
    colliding.push(...rest.slice(0, 3 * SHARED_PER_ROUTE).flatMap((bookmark) => (bookmark.slug !== null && ownerSlugs.has(bookmark.slug) ? [bookmark.slug] : [])));
  });
  const renamedSlugs = new Set(renamed.values());
  return {
    workspace: {
      ...large,
      bookmarks: large.bookmarks.map((bookmark) => {
        const slug = renamed.get(bookmark.id);
        return slug === undefined ? bookmark : { ...bookmark, slug };
      }),
      folders: [...large.folders, ...folders],
      folderBookmarks: [...large.folderBookmarks, ...folderBookmarks],
      teams: [team],
      bookmarkShares,
      folderShares,
    },
    collidingSlugs: [...new Set(colliding)].sort(),
    sharedSlugs: renamedSlugs.has(SHARED_SINGLE_SLUG) ? [SHARED_SINGLE_SLUG] : [],
    ambiguousSlugs: bookmarkShares.filter((entry) => renamed.get(entry.subjectId) === SHARED_MANY_SLUG).length > 1 ? [SHARED_MANY_SLUG] : [],
  };
}

/**
 * The instance of doc 08 section 5.3. The large workspace belongs to the instance admin and has two more members; it holds
 * `bookmarks` rows, about one in eight of them with a slug, four in ten tagged and a third filed in a folder. Each of the
 * `workspaces` further workspaces has an owner of its own and a few such rows.
 */
export function buildLargeInstance(options: LargeInstanceOptions = {}): LargeInstance {
  const random = createRandom(options.seed ?? LARGE_INSTANCE_SEED);
  const ids = createIds(random, DEMO_NOW.getTime() - 400 * 86_400_000);
  const population = { random, ids };
  const account = (email: string, displayName: string, isInstanceAdmin = false): LargeAccount => ({ id: ids(), email, displayName, isInstanceAdmin });
  const admin = account("perf-admin@example.test", "Perf Admin", true);
  const members = [account("perf-member-1@example.test", "Perf Member 1"), account("perf-member-2@example.test", "Perf Member 2")];
  const accounts: LargeAccount[] = [admin, ...members];
  const owners = [...Array.from({ length: ADMIN_WEIGHT }, () => admin.id), ...members.map((member) => member.id)];
  const large = populate(
    population,
    { id: ids(), name: "Large workspace", ownerId: admin.id, members: members.map((member) => ({ accountId: member.id, role: "member" as const })) },
    owners,
    options.bookmarks ?? PERF_BOOKMARK_COUNT,
    TAG_NAMES.length,
    FOLDER_NAMES.length,
  );
  const workspaces: LargeWorkspace[] = [large];
  for (let index = 1; index <= (options.workspaces ?? PERF_EXTRA_WORKSPACES); index += 1) {
    const owner = account(`perf-owner-${String(index)}@example.test`, `Perf Owner ${String(index)}`);
    accounts.push(owner);
    workspaces.push(populate(population, { id: ids(), name: `Workspace ${String(index)}`, ownerId: owner.id, members: [] }, [owner.id], PERF_EXTRA_WORKSPACE_BOOKMARKS, 3, 2));
  }
  const shared = shareWithOwner(large, admin.id, members.map((member) => member.id), ids);
  workspaces[0] = shared.workspace;
  const forwarding = large.bookmarks.filter((bookmark) => bookmark.ownerId === admin.id && bookmark.forwarding && bookmark.slug !== null);
  const step = Math.max(1, Math.floor(forwarding.length / SLUG_SAMPLE));
  return {
    accounts,
    workspaces,
    fixtures: {
      email: admin.email,
      slugs: forwarding.filter((_, index) => index % step === 0).map((bookmark) => bookmark.slug ?? ""),
      tagIds: large.tags.filter((tag) => tag.ownerId === admin.id).map((tag) => tag.id),
      folderIds: large.folders.filter((folder) => folder.ownerId === admin.id).map((folder) => folder.id),
      searchTerms: SEARCH_TERMS,
      collidingSlugs: shared.collidingSlugs,
      sharedSlugs: shared.sharedSlugs,
      ambiguousSlugs: shared.ambiguousSlugs,
      sharedSearchTerms: [...shared.sharedSlugs, ...shared.ambiguousSlugs],
    },
  };
}
