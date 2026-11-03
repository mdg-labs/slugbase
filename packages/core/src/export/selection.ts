import { EXPORT_SELECTION_IDS_MAX } from "@slugbase/contracts";
import { BOOKMARK_SELECT_ALL_CAP, type BookmarkBulkStore } from "../bookmarks/bulk.ts";
import { bookmarkListFilter, type BookmarkFilterAsk, type BookmarkScope } from "../bookmarks/list.ts";
import type { BookmarkUrlRefusal } from "../bookmarks/url.ts";

// The selection of an export (doc 02 section 5.8, doc 04 section 10.9): the bookmarks the request names by identifier, or the ones the filters of the list match, which the export then reads as `only`. Naming is no reading: an identifier is
// kept whether or not the member can read the bookmark, and the reads of the export match it against what the member owns and what is shared with them, so one they can read neither of is dropped there without being told apart from one that
// never existed. A selection by the filters is resolved as the select-all of the list is (`BookmarkBulkStore.ids`), and refused where a bulk request by the same filters is refused, above the select-all cap, rather than cut at it.

/** What a request selects: bookmarks by identifier, or by the filters of the list. */
export type ExportSelection =
  | { readonly kind: "ids"; readonly ids: readonly string[] }
  | { readonly kind: "filter"; readonly filter: BookmarkFilterAsk & { readonly scope: BookmarkScope } };

export type ExportSelectionOutcome =
  /** The identifiers to export, lower-cased and without repeats. */
  | { readonly kind: "selected"; readonly only: readonly string[] }
  /** More identifiers are named than an export takes, or the filters match more bookmarks than the select-all cap; nothing was read for the export. */
  | { readonly kind: "too_many"; readonly limit: number }
  /** The `url` filter is not a URL a bookmark can have; nothing was read. */
  | { readonly kind: "url_refused"; readonly reason: BookmarkUrlRefusal };

/** The identifiers an export of `selection` reads, in the transaction `store` is bound to. */
export async function resolveExportSelection(store: Pick<BookmarkBulkStore, "ids">, selection: ExportSelection): Promise<ExportSelectionOutcome> {
  if (selection.kind === "ids") {
    const only = [...new Set(selection.ids.map((id) => id.toLowerCase()))];
    return only.length > EXPORT_SELECTION_IDS_MAX ? { kind: "too_many", limit: EXPORT_SELECTION_IDS_MAX } : { kind: "selected", only };
  }
  const parsed = bookmarkListFilter(selection.filter);
  if (!parsed.ok) {
    return { kind: "url_refused", reason: parsed.reason };
  }
  // One more than the cap, to know whether more match.
  const found = await store.ids(parsed.filter, BOOKMARK_SELECT_ALL_CAP + 1);
  return found.length > BOOKMARK_SELECT_ALL_CAP ? { kind: "too_many", limit: BOOKMARK_SELECT_ALL_CAP } : { kind: "selected", only: found.map((id) => id.toLowerCase()) };
}
