import { parseSlug } from "./slug.ts";

// The resolution of a slug for a member (doc 02 sections 6.2 to 6.4, doc 05 section 4, Q25, doc 10 T1, T2 and T12). The candidates are the bookmarks of the
// workspace of the transaction that have the slug, forward, are not plan-archived and that the member can read, which the store decides (today a bookmark
// is readable by its owner; sharing, when it is built, widens the store's predicate and nothing here). The choice among them is made here, in the order of Q25: a
// remembered preference that is still a candidate, then the member's own bookmark, then the one shared candidate, then the several shared candidates, which
// the member picks from. Nothing is found for a slug outside the grammar, and a bookmark the member cannot read is never named, so a slug that exists only in
// another workspace, or only as another member's private bookmark, resolves to nothing.

/** How the member can read a candidate: as its owner, or through a direct share, a team's share or a shared folder. */
export type GoAccess = "owner" | "direct" | "team" | "folder";

/** A bookmark that has the slug and that the member can read, as the candidate scan of the store finds it. */
export interface GoCandidate {
  readonly id: string;
  /** The owner's account; null for a bookmark whose owner has left the workspace. */
  readonly ownerId: string | null;
  /** The destination as stored. */
  readonly url: string;
  readonly access: GoAccess;
}

export interface GoCandidateSet {
  readonly candidates: readonly GoCandidate[];
  /** The bookmark the member remembered for the slug; it may no longer be a candidate. */
  readonly preferredId: string | undefined;
}

/** What the resolution names of a candidate: enough to choose it, not its address. */
export interface GoBookmarkSummary {
  readonly id: string;
  readonly title: string;
  /** The host of the destination. */
  readonly host: string;
  readonly ownerId: string | null;
  /** The owner's display name, as the member sees it as a co-member; null when the owner has left. */
  readonly ownerName: string | null;
}

export interface GoStore {
  /** The candidates of `slug` (normalised) for `accountId` in the workspace of the transaction, and the member's remembered choice for it. */
  candidates(request: { readonly slug: string; readonly accountId: string }): Promise<GoCandidateSet>;
  /** The summaries of the bookmarks of `ids` that the member can read, in no particular order. */
  summaries(ids: readonly string[]): Promise<readonly GoBookmarkSummary[]>;
  /**
   * Remembers `bookmarkId` as the member's choice for `slug`, replacing an earlier one, and answers whether it did. It answers false, writing nothing, when the
   * bookmark is no longer a candidate of the slug for the member, so a preference never names a bookmark that cannot be resolved to.
   */
  remember(request: { readonly slug: string; readonly bookmarkId: string; readonly accountId: string }): Promise<boolean>;
}

/** One bookmark the resolution names. */
export interface GoChoice {
  readonly id: string;
  readonly title: string;
  readonly host: string;
  /** Who owns a bookmark shared with the member; null for the member's own and for one whose owner has left. */
  readonly owner: { readonly accountId: string; readonly displayName: string } | null;
  /** How a bookmark is shared with the member; null for the member's own. */
  readonly sharedVia: "direct" | "team" | "folder" | null;
}

export type GoResolution =
  /** Nothing the member can read has the slug (or the slug is not one). */
  | { readonly kind: "none" }
  /** The member's remembered choice, which is still a candidate. */
  | { readonly kind: "preferred"; readonly bookmark: GoChoice }
  /** The member's own bookmark, or the one bookmark shared with them. */
  | { readonly kind: "single"; readonly bookmark: GoChoice }
  /** Several bookmarks shared with the member and none of their own, for the member to choose from, in the order of their titles. */
  | { readonly kind: "multiple"; readonly candidates: readonly GoChoice[] };

export interface GoResolveDependencies {
  readonly store: Pick<GoStore, "candidates" | "summaries">;
}

export interface GoResolveAsk {
  /** The member who resolves. */
  readonly accountId: string;
  /** The slug as the caller wrote it. */
  readonly slug: string;
}

function choiceOf(candidate: GoCandidate, summary: GoBookmarkSummary): GoChoice {
  const own = candidate.access === "owner";
  return {
    id: summary.id,
    title: summary.title,
    host: summary.host,
    owner: !own && summary.ownerId !== null && summary.ownerName !== null ? { accountId: summary.ownerId, displayName: summary.ownerName } : null,
    sharedVia: own ? null : candidate.access,
  };
}

function byTitle(a: GoChoice, b: GoChoice): number {
  const titles = a.title.toLowerCase().localeCompare(b.title.toLowerCase(), "en");
  return titles !== 0 ? titles : a.id.localeCompare(b.id, "en");
}

/** The candidates of `slug` for the account, among those that still exist, in the order of Q25. */
export async function resolveSlug({ store }: GoResolveDependencies, ask: GoResolveAsk): Promise<GoResolution> {
  const accountId = ask.accountId.toLowerCase();
  const slug = parseSlug(ask.slug);
  if (slug === undefined) {
    return { kind: "none" };
  }
  const found = await store.candidates({ slug, accountId });
  if (found.candidates.length === 0) {
    return { kind: "none" };
  }
  // A candidate that was deleted between the two reads has no summary and is no longer one.
  const summaries = new Map((await store.summaries(found.candidates.map((candidate) => candidate.id))).map((summary) => [summary.id, summary]));
  const choices = found.candidates.flatMap((candidate) => {
    const summary = summaries.get(candidate.id);
    return summary === undefined ? [] : [{ candidate, choice: choiceOf(candidate, summary) }];
  });

  const preferred = found.preferredId === undefined ? undefined : choices.find(({ choice }) => choice.id === found.preferredId);
  if (preferred !== undefined) {
    return { kind: "preferred", bookmark: preferred.choice };
  }
  const own = choices.filter(({ candidate }) => candidate.access === "owner" && candidate.ownerId === accountId).sort((a, b) => byTitle(a.choice, b.choice))[0];
  if (own !== undefined) {
    return { kind: "single", bookmark: own.choice };
  }
  const shared = choices.filter(({ candidate }) => candidate.access !== "owner").map(({ choice }) => choice);
  const [only, ...others] = shared;
  if (only === undefined) {
    return { kind: "none" };
  }
  return others.length === 0 ? { kind: "single", bookmark: only } : { kind: "multiple", candidates: shared.sort(byTitle) };
}
