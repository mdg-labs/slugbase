import type { AccountAccessModeRecord } from "@slugbase/db";
import type { ChainContext } from "./chain.ts";
import { ProblemError } from "./problem.ts";

// The access-mode check of stage 4 (doc 01 section 4, doc 02 section 2.11, doc 04 section 3.2, doc 10 T4 and T18), run right
// after the credential became a principal and before any other stage or any handler. While an account is in the export-only mode its
// sessions and API tokens still resolve, so that the account can sign in and take its data out, and this check refuses everything else
// with `403 account_export_only`, so no route can forget it: an API-token request, every `/go` redirect, accepting an invitation and
// every write. A session may call only the operations below, which read what the account can see, run the two exports, change which
// workspace the session acts in, delete the account itself and finish a sign-in or a sign-out. A request without a principal is not the
// account's and is outside this check; the sign-in and recovery operations that need none are the account's way in, not a use of it.

/** The operations a session of an export-only account may call; every other operation, and every operation of an API token, is refused. */
export const EXPORT_ONLY_OPERATIONS: ReadonlySet<string> = new Set([
  // Finishing a sign-in and ending the session, which also serve a session waiting for its second factor.
  "verifyMfa",
  "logout",
  // The configuration the web app reads at boot with its session cookie, which is anonymous by policy and shows nothing of the account.
  "getApiConfig",
  // Reading the account itself and the workspaces, bookmarks, folders and tags it can see.
  "getMe",
  "listWorkspaces",
  "getWorkspace",
  "setActiveWorkspace",
  "listBookmarks",
  "listBookmarkIds",
  "getBookmark",
  "listFolders",
  "getFolder",
  "listTags",
  "getTagStats",
  // The two exports.
  "exportJson",
  "exportNetscape",
  // The account's own deletion, which the open question of the item leaves to the account: it needs a fresh re-authentication.
  "reauthenticate",
  "deleteMe",
]);

/** Where the check reads the access mode of an account from, once per request that needs it. */
export interface AccessModeSource {
  /** The mode of the account; undefined when it does not exist. Rejects when the database cannot answer. */
  accountAccessMode(accountId: string): Promise<AccountAccessModeRecord | undefined>;
}

const DETAIL = "This account can only read and export its data until its access ends.";

/**
 * A request of a principal that is not a session calling an allowed operation reads the account's mode from the database, and
 * an export-only account is refused with `403 account_export_only`, naming when the period ends. A database that cannot answer
 * is an error, never a request that goes on, and an account that is gone since the credential resolved is `401 unauthenticated`.
 */
export function createAccessModeCheck({ source }: { readonly source: AccessModeSource }): (context: ChainContext, next: () => Promise<void>) => Promise<void> {
  return async (context, next) => {
    const principal = context.get("principal");
    const operation = context.get("route")?.operation;
    if (principal === undefined || operation === undefined) {
      return next();
    }
    if (principal.kind === "session" && EXPORT_ONLY_OPERATIONS.has(operation.operationId)) {
      return next();
    }
    const mode = await source.accountAccessMode(principal.accountId);
    if (mode === undefined) {
      throw new ProblemError("unauthenticated", "The credential was not accepted.");
    }
    if (mode.mode === "exportOnly") {
      throw new ProblemError("account_export_only", DETAIL, { members: { until: mode.until.toISOString() } });
    }
    return next();
  };
}
