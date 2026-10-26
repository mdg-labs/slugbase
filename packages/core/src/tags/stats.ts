import { TAG_LIST_TOTAL_CAP } from "./list.ts";
import type { TagRecord, TagStore } from "./create.ts";

// The distribution of a member's tags (doc 02 section 7.2, doc 04 section 10.7, Q42): the most used tags the account owns in the workspace,
// each with the number of its bookmarks that are not plan-archived, and how many tags the account has in all, exact up to
// `TAG_LIST_TOTAL_CAP` and not counted beyond it. Another member's tags are not in the answer, whatever the store is asked for.

export interface TagStatsDependencies {
  readonly store: Pick<TagStore, "list" | "count">;
}

export interface TagStatsAsk {
  /** The member whose tags are reported. */
  readonly accountId: string;
  /** 1 to 100. */
  readonly limit: number;
}

export interface TagStatsOutcome {
  /** The most used first, then by name, then by identifier. */
  readonly items: readonly TagRecord[];
  /** The number of the member's tags; null when there are more than `TAG_LIST_TOTAL_CAP`. */
  readonly total: number | null;
}

export async function tagStats({ store }: TagStatsDependencies, ask: TagStatsAsk): Promise<TagStatsOutcome> {
  const ownerId = ask.accountId.toLowerCase();
  const items = await store.list({ ownerId, sort: "count", after: undefined, limit: ask.limit });
  const counted = await store.count(ownerId, TAG_LIST_TOTAL_CAP + 1);
  return { items, total: counted > TAG_LIST_TOTAL_CAP ? null : counted };
}
