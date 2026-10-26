import type { BookmarkUsage } from "../bookmarks/open.ts";
import { chooseSlugBookmark } from "./choose.ts";
import { resolveSlug, type GoStore } from "./resolve.ts";
import { parseSlug } from "./slug.ts";

// What a browser navigation to `/go/<slug>` is answered with (doc 02 section 6.2, doc 04 section 9.3, doc 10 T1, T2 and T12): the resolution of the slug for the
// member in the order of Q25, and, when it names one bookmark (a remembered choice, the member's own bookmark or the one shared with them), the address to forward
// to, which is the choice of that bookmark and so is judged again as a current candidate, checked again to be an `http` or `https` URL and counted as one use in
// the usage buffer. Several shared bookmarks are left to the member to choose from. Nothing that resolves to a bookmark whose address cannot be forwarded to is
// told apart from a slug that resolves to nothing: both are `not_found`, and nothing is counted.

export interface GoNavigateDependencies {
  readonly store: GoStore;
  readonly usage: BookmarkUsage;
}

export interface GoNavigateAsk {
  /** The member who navigates. */
  readonly accountId: string;
  /** The slug as the address carried it. */
  readonly slug: string;
}

export type GoNavigation =
  /** Forward to this address, an `http` or `https` URL; the use is counted. */
  | { readonly kind: "forward"; readonly url: string }
  /** Several bookmarks shared with the member have the slug and none is preferred: the member chooses. */
  | { readonly kind: "choose" }
  /** Nothing the member can read has the slug, or what does cannot be forwarded to. */
  | { readonly kind: "not_found" };

export async function navigateToSlug({ store, usage }: GoNavigateDependencies, ask: GoNavigateAsk): Promise<GoNavigation> {
  const slug = parseSlug(ask.slug);
  if (slug === undefined) {
    return { kind: "not_found" };
  }
  const resolution = await resolveSlug({ store }, { accountId: ask.accountId, slug });
  switch (resolution.kind) {
    case "none":
      return { kind: "not_found" };
    case "multiple":
      return { kind: "choose" };
    case "preferred":
    case "single": {
      const outcome = await chooseSlugBookmark({ store, usage }, { accountId: ask.accountId, slug, bookmarkId: resolution.bookmark.id, remember: false });
      return outcome.kind === "chosen" ? { kind: "forward", url: outcome.url } : { kind: "not_found" };
    }
  }
}
