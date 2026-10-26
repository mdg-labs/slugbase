import type { BookmarkUsage } from "../bookmarks/open.ts";
import { normalizeBookmarkUrl } from "../bookmarks/url.ts";
import type { GoStore } from "./resolve.ts";
import { parseSlug } from "./slug.ts";

// Choosing a candidate of a slug (doc 02 sections 6.2 to 6.4, doc 04 section 10.8, doc 10 T1, T2 and T12). The bookmark has to be a current candidate of the
// slug for the member, which is judged again here and not taken from what a resolution once answered: the one named by a caller is otherwise any identifier,
// and a bookmark that is another member's, another workspace's, not forwarding, plan-archived or without the slug is the same `not_found` a slug that
// resolves to nothing is. The destination is checked to be an `http` or `https` URL before anything is written, so a preference is never stored for a bookmark
// that cannot be forwarded to. The preference is written only if the bookmark is still a candidate when it is written, and the use is counted last,
// in the usage buffer, which never blocks the answer.

export interface GoChooseDependencies {
  readonly store: GoStore;
  readonly usage: BookmarkUsage;
}

export interface GoChooseAsk {
  /** The member who chooses. */
  readonly accountId: string;
  /** The slug as the caller wrote it. */
  readonly slug: string;
  readonly bookmarkId: string;
  /** Whether to remember the choice for the slug. */
  readonly remember: boolean;
}

export type GoChooseOutcome =
  /** The destination to go to; the use is counted and the choice remembered when it was asked for. */
  | { readonly kind: "chosen"; readonly url: string }
  /** The bookmark is no candidate of the slug for the member; which of the reasons it is stays unsaid. Nothing is written or counted. */
  | { readonly kind: "not_found" }
  /** The stored URL is not an `http` or `https` URL. Nothing is written or counted. */
  | { readonly kind: "url_refused" };

export async function chooseSlugBookmark({ store, usage }: GoChooseDependencies, ask: GoChooseAsk): Promise<GoChooseOutcome> {
  const accountId = ask.accountId.toLowerCase();
  const bookmarkId = ask.bookmarkId.toLowerCase();
  const slug = parseSlug(ask.slug);
  if (slug === undefined) {
    return { kind: "not_found" };
  }
  const { candidates } = await store.candidates({ slug, accountId });
  const chosen = candidates.find((candidate) => candidate.id === bookmarkId);
  if (chosen === undefined) {
    return { kind: "not_found" };
  }
  const destination = normalizeBookmarkUrl(chosen.url);
  if (!destination.ok) {
    return { kind: "url_refused" };
  }
  if (ask.remember && !(await store.remember({ slug, bookmarkId, accountId }))) {
    return { kind: "not_found" };
  }
  usage.record(bookmarkId);
  return { kind: "chosen", url: destination.value.url };
}
