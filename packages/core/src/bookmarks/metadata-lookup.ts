import type { EgressPort } from "../ports/egress.ts";
import type { PageMetadata } from "./metadata.ts";
import { fetchPageMetadata } from "./page-fetch.ts";
import { normalizeBookmarkUrl, type BookmarkUrlRefusal } from "./url.ts";

// The synchronous metadata lookup (doc 02 sections 5.4 and 16, doc 04 sections 3.2 and 10.6, doc 10 T6 and T13): the modal asks for the title and
// description of a page while it is open. The URL is judged as a bookmark's URL is and then fetched in its canonical form, which keys the workspace's
// cache. A successful result that has not expired is answered from the cache; otherwise the page is fetched through the egress port, with no
// transaction open, and the result is cached. Only a successful fetch is cached: a refusal or a failure of this lookup stores nothing, so a page that
// was slow or down for a request that waits three seconds is still tried by the job, which waits ten, and a stored `failed` or `blocked` row of the
// job is not served as an answer (the fetch is tried again). The fetch is held to what is left of `budgetMs` once the cache has been read, redirects
// included, and a budget that is spent before the fetch can start is a failure.

/** A cached result of the workspace for one canonical URL, as the cache holds it. */
export type CachedPageMetadata = PageMetadata & { readonly status: "ok" | "failed" | "blocked" };

export interface PageMetadataCache {
  /** The result stored for the canonical URL in the workspace when it has not expired; undefined otherwise. Reads in a transaction of its own. */
  read(urlCanonical: string): Promise<CachedPageMetadata | undefined>;
  /** Stores a successful result for the canonical URL in the workspace, replacing an earlier one. Writes in a transaction of its own. */
  write(urlCanonical: string, page: PageMetadata): Promise<void>;
}

export interface PageMetadataLookupDependencies {
  readonly egress: EgressPort;
  readonly cache: PageMetadataCache;
  /** The most the cache read and the fetch may take together, in milliseconds. */
  readonly budgetMs: number;
  /** The clock the budget is measured on, in milliseconds. */
  readonly now: () => number;
}

export type PageMetadataLookupOutcome =
  | { readonly kind: "found"; readonly page: PageMetadata; readonly cached: boolean }
  /** The value is not a URL that can be fetched; nothing was read or requested. */
  | { readonly kind: "url_refused"; readonly reason: BookmarkUrlRefusal }
  /** The egress port refuses the target. */
  | { readonly kind: "blocked" }
  /** The page could not be read, or the budget ran out. */
  | { readonly kind: "failed" };

function pageOf(row: PageMetadata): PageMetadata {
  return { title: row.title, description: row.description, siteName: row.siteName, canonicalUrl: row.canonicalUrl, language: row.language };
}

export async function lookupPageMetadata(dependencies: PageMetadataLookupDependencies, url: string): Promise<PageMetadataLookupOutcome> {
  const started = dependencies.now();
  const normalised = normalizeBookmarkUrl(url);
  if (!normalised.ok) {
    return { kind: "url_refused", reason: normalised.reason };
  }
  const urlCanonical = normalised.value.canonical;
  const cached = await dependencies.cache.read(urlCanonical);
  if (cached?.status === "ok") {
    return { kind: "found", page: pageOf(cached), cached: true };
  }
  const remaining = Math.floor(dependencies.budgetMs - (dependencies.now() - started));
  if (remaining < 1) {
    return { kind: "failed" };
  }
  const outcome = await fetchPageMetadata(dependencies.egress, urlCanonical, remaining);
  if (outcome.kind !== "ok") {
    return outcome;
  }
  await dependencies.cache.write(urlCanonical, outcome.page);
  return { kind: "found", page: outcome.page, cached: false };
}
