import type { ShareTargetRecord, ShareTargetSearch, ShareTargetStore } from "./store.ts";

// Finding whom to share with (doc 02 section 8.3, doc 04 section 10.7). The members and the teams of the workspace are offered to every member
// who holds the entitlement of their kind, apart from the caller, who is never a target. The store names the workspace in each statement, so a
// member or a team of another workspace is never offered.

export interface ShareTargetDependencies {
  readonly store: ShareTargetStore;
}

export function findShareTargets({ store }: ShareTargetDependencies, search: ShareTargetSearch): Promise<readonly ShareTargetRecord[]> {
  if (search.kinds.length === 0) {
    return Promise.resolve([]);
  }
  return store.search(search);
}
