import { z } from "zod";
import { defineOperation, emptyResponse, jsonResponse, problemResponse, rateLimitedResponse } from "./define.ts";
import { GO_SHARED_VIA } from "./go.ts";
import { SEARCH_QUERY_MAX_LENGTH } from "./search.ts";
import { SHARE_TARGET_KINDS } from "./sharing.ts";
import { TAG_NAME_MAX_LENGTH } from "./tags.ts";
import { withoutNul } from "./text.ts";

// The bookmarks tag of doc 04 section 10.6: the operations that create a bookmark, read it back, change it and delete it. They
// act in the workspace the request is bound to and name none (D11), and a bookmark is its owner's: another member's bookmark of
// the same workspace that is not shared with the caller, one whose owner has left the workspace and that is not shared with the caller, and any bookmark of
// another workspace are answered 404, like one that does not exist (doc 04 section 2.4, doc 10 T1 and T2). A bookmark that is shared with the caller, directly,
// through a team or through a folder, and that they do not own (another member's, or one whose owner has left the workspace, since a share stays), is one they
// can read and open, and the list can be narrowed to those or to the caller's own; they may not change it, tag it, file it or share it, and a try is
// answered 403 forbidden (doc 02 section 8.2, Q22); a plan-archived bookmark is never counted as shared, so a recipient's try on one is answered 404. The URL is stored normalised and only `http` and `https` are stored (doc 02 section 5.1, doc 10 T12 and
// T13). The list pages through the bookmarks its scope covers by a signed keyset cursor (doc 04 section 6.1). An open records that the
// caller used a bookmark and answers the destination to go to (doc 02 section 5.5). A bookmark is filed in the caller's own folders by
// `folderIds` on a creation and a change, and the list can be narrowed to one folder; a folder that is another member's, another
// workspace's or unknown is answered 404 and files nothing (doc 02 sections 7.1 and 8.2, Q22). A bookmark is tagged with the caller's own
// tags in the same way, by `tagIds` and by `tagNames` (a name the caller has no tag of creates one), and the list can be narrowed to the
// bookmarks that carry every one of several tags (AND, doc 04 section 6.1); a tag that is another member's, another workspace's or unknown is
// answered 404 and tags nothing (doc 02 sections 7.2 and 8.2, Q22). Every bookmark body carries the caller's own tags and nobody else's. A creation and a
// change set, change and clear the slug and the forwarding flag of a bookmark (doc 02 section 6.1): the server trims and lower-cases a slug before it
// validates it, a slug is unique per owner within the workspace, and forwarding needs a slug. Whether a slug is free is answered by the availability
// query (doc 04 section 10.6). A bulk request deletes, pins, unpins, files in a folder (adds to it, moves to it, takes out of it) or tags (adds tags, removes tags) many of the caller's own
// bookmarks at once, named by identifier or by the list's filters, in one transaction; the folder or the tags it acts with are the caller's own, and one that is
// not is answered 404 with nothing changed (doc 02 section 5.8). The preview of adding tags answers the tag set the bookmarks would carry, without writing. The
// select-all operation returns the identifiers a filter matches so a client can name them. The metadata operation reads the title and description of a page for the modal that is open, from the workspace's cache or from a fetch through the egress adapter within three seconds; an address the server refuses to connect to is 422 url_not_allowed, a page that cannot be read is 502 upstream_failed, and it takes from the fetch bucket and needs the write scope because it writes the cache (doc 04 sections 3.2, 7 and 10.6). The text query `q` narrows the list, the select-all and a bulk request by filter to the bookmarks the
// search of doc 02 section 9.1 finds by their title, host, slug and description (never the path of the URL), in the order the list is asked for and not by relevance; it is plain text.

/** The longest bookmark URL, in characters (doc 02 section 5.1). */
export const BOOKMARK_URL_MAX_LENGTH = 2048;

/** The longest bookmark title, in characters (doc 02 section 5.1). */
export const BOOKMARK_TITLE_MAX_LENGTH = 300;

/** The longest bookmark description, in characters (doc 02 section 5.1). */
export const BOOKMARK_DESCRIPTION_MAX_LENGTH = 1000;

/** The most folders a creation or a change names for one bookmark. */
export const BOOKMARK_FOLDER_IDS_MAX = 100;

/** The longest slug, in characters (doc 02 section 6.1). */
export const BOOKMARK_SLUG_MAX_LENGTH = 64;

/** The grammar of a slug once it is trimmed and lower-cased (doc 02 section 6.1, doc 05 section 2.4): 1 to 64 lower-case letters, digits and hyphens, not starting with a hyphen. There are no reserved words. */
export const BOOKMARK_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

const BookmarkFolderIdsSchema = z.array(z.uuid()).max(BOOKMARK_FOLDER_IDS_MAX);

/** The most tags a creation or a change names for one bookmark, by identifier and by name each. */
export const BOOKMARK_TAGS_MAX = 100;

/** The most tags a list is narrowed to at once. */
export const BOOKMARK_TAG_FILTER_MAX = 10;

const BookmarkTagIdsSchema = z.array(z.uuid()).max(BOOKMARK_TAGS_MAX);

const BookmarkTagNamesSchema = z.array(withoutNul(z.string().trim().min(1).max(TAG_NAME_MAX_LENGTH))).max(BOOKMARK_TAGS_MAX);

export const CreateBookmarkRequestSchema = z
  .strictObject({
    url: z
      .string()
      .min(1)
      .max(BOOKMARK_URL_MAX_LENGTH)
      .describe(
        "The address to save: an http or https URL of at most 2 048 characters. It is stored with a lower-case scheme and host, an internationalised host name in punycode, the default port left out and the fragment kept. Any other scheme is refused with 422 url_not_allowed",
      ),
    title: withoutNul(z.string().trim().min(1).max(BOOKMARK_TITLE_MAX_LENGTH)).describe("The bookmark's title, 1 to 300 characters; surrounding whitespace is removed and a title that is blank after that is refused"),
    description: withoutNul(z.string().trim().max(BOOKMARK_DESCRIPTION_MAX_LENGTH))
      .optional()
      .describe("The bookmark's description, 0 to 1 000 characters; surrounding whitespace is removed and an empty one is stored as none"),
    pinned: z.boolean().optional().describe("Whether the bookmark is pinned; not pinned when left out"),
    slug: z
      .string()
      .optional()
      .describe(
        "The bookmark's slug: it is trimmed and lower-cased, then it must be 1 to 64 lower-case letters, digits and hyphens that do not start with a hyphen, or the request is refused with 422 validation_failed on slug; there are no reserved words. A slug the caller already uses in the workspace is refused with 409 slug_taken. The bookmark has no slug when left out",
      ),
    forwarding: z
      .boolean()
      .optional()
      .describe("Whether /go forwards to the bookmark by its slug. It needs a slug: true without one is refused with 422 validation_failed on forwarding. Left out, it is true when a slug is given and false otherwise"),
    folderIds: BookmarkFolderIdsSchema.optional().describe(
      "The caller's folders to file the bookmark in, at most 100 identifiers; one named twice counts once. A folder that is another member's, another workspace's or unknown is refused with 404 and nothing is created. Filed in none when left out",
    ),
    tagIds: BookmarkTagIdsSchema.optional().describe(
      "The caller's tags to put on the bookmark, at most 100 identifiers; one named twice counts once. A tag that is another member's, another workspace's or unknown is refused with 404 and nothing is created. Together with tagNames they name the union. No tags when both are left out",
    ),
    tagNames: BookmarkTagNamesSchema.optional().describe(
      "The names of the tags to put on the bookmark, at most 100, each 1 to 40 characters after the whitespace around it is removed. The caller's tag of that name is used, whatever the case it is written in, and a name the caller has no tag of creates one in the same transaction; two spellings of one name count once",
    ),
  })
  .meta({ id: "CreateBookmarkRequest" });

export const UpdateBookmarkRequestSchema = z
  .strictObject({
    url: z
      .string()
      .min(1)
      .max(BOOKMARK_URL_MAX_LENGTH)
      .optional()
      .describe(
        "The new address: an http or https URL of at most 2 048 characters, stored as a creation stores it; the canonical form and the host are derived again. Any other scheme is refused with 422 url_not_allowed. Left out, the address is left as it is",
      ),
    title: withoutNul(z.string().trim().min(1).max(BOOKMARK_TITLE_MAX_LENGTH)).optional().describe("The new title, 1 to 300 characters; surrounding whitespace is removed and a title that is blank after that is refused. It cannot be cleared. Left out, the title is left as it is"),
    description: withoutNul(z.string().trim().max(BOOKMARK_DESCRIPTION_MAX_LENGTH))
      .nullable()
      .optional()
      .describe("The new description, 0 to 1 000 characters; surrounding whitespace is removed, and an empty one and null clear it. Left out, the description is left as it is"),
    pinned: z.boolean().optional().describe("Pins or unpins the bookmark; left out, the pin is left as it is"),
    slug: z
      .string()
      .nullable()
      .optional()
      .describe(
        "The new slug, trimmed and lower-cased and then held to the grammar of a creation (422 validation_failed on slug otherwise); null clears it. A slug the caller already uses on another bookmark in the workspace is refused with 409 slug_taken. Clearing the slug of a bookmark that forwards is refused with 422 validation_failed on forwarding unless the same patch turns forwarding off. Left out, the slug is left as it is",
      ),
    forwarding: z
      .boolean()
      .optional()
      .describe("Turns forwarding on or off; turning it off keeps the slug. True needs a slug, the bookmark's or the patch's, or the request is refused with 422 validation_failed on forwarding. Left out, forwarding is left as it is"),
    folderIds: BookmarkFolderIdsSchema.optional().describe(
      "The caller's folders the bookmark is filed in afterwards, at most 100 identifiers: the list replaces the folders it is in, and an empty list takes it out of all of them. Filing moves no version. A folder that is another member's, another workspace's or unknown is refused with 404 and nothing is changed. Left out, the folders are left as they are",
    ),
    tagIds: BookmarkTagIdsSchema.optional().describe(
      "The caller's tags the bookmark carries afterwards, at most 100 identifiers. With tagNames they name the union, which replaces the tags the bookmark has; an empty list takes all of them off. Tagging moves no version. A tag that is another member's, another workspace's or unknown is refused with 404 and nothing is changed. Left out together with tagNames, the tags are left as they are",
    ),
    tagNames: BookmarkTagNamesSchema.optional().describe(
      "The names of the tags the bookmark carries afterwards, at most 100, each 1 to 40 characters after the whitespace around it is removed. The caller's tag of that name is used, whatever the case it is written in, and a name the caller has no tag of creates one in the same transaction. With tagIds they name the union, which replaces the tags the bookmark has",
    ),
  })
  .meta({ id: "UpdateBookmarkRequest" });

export const BookmarkFolderSchema = z
  .strictObject({
    id: z.uuid().describe("The folder's identifier"),
    name: z.string().describe("The folder's name, in the case it was entered in"),
    icon: z.string().describe("The folder's icon, a lucide icon name"),
    color: z.number().int().min(1).max(8).describe("The folder's colour, 1 to 8: the number of the --folder-N theme token"),
  })
  .meta({ id: "BookmarkFolder" });

export const BookmarkTagSchema = z
  .strictObject({
    id: z.uuid().describe("The tag's identifier"),
    name: z.string().describe("The tag's name, in the case it was entered in"),
  })
  .meta({ id: "BookmarkTag" });

export const BookmarkSchema = z
  .strictObject({
    id: z.uuid().describe("The bookmark's identifier"),
    ownerId: z.uuid().nullable().describe("The account of the member who owns the bookmark; null once that member has left the workspace"),
    url: z.string().describe("The URL as stored: normalised, and always http or https"),
    host: z.string().describe("The host name of the URL, lower case and in punycode"),
    title: z.string().describe("The bookmark's title"),
    description: z.string().nullable().describe("The bookmark's description, null when it has none"),
    slug: z.string().nullable().describe("The bookmark's slug, null when it has none"),
    forwarding: z.boolean().describe("Whether /go forwards to the bookmark by its slug"),
    pinned: z.boolean().describe("Whether the caller pinned the bookmark; always false for a bookmark that is shared with the caller, since a pin is the owner's"),
    openCount: z.number().int().min(0).describe("How many times the bookmark was opened, by everyone it is shared with included"),
    lastOpenedAt: z.iso.datetime().nullable().describe("When the bookmark was last opened, RFC 3339 UTC, null when it never was"),
    owner: z
      .strictObject({
        accountId: z.uuid().describe("The owner's account"),
        displayName: z.string().describe("The owner's display name, as a member of the workspace sees it"),
      })
      .nullable()
      .optional()
      .describe("Who owns a bookmark that is shared with the caller; null for the caller's own bookmark and for one whose owner has left the workspace. The server always sends it; a client reads an absent value as null"),
    sharedVia: z
      .enum(GO_SHARED_VIA)
      .nullable()
      .optional()
      .describe("How the bookmark is shared with the caller: directly, through a team or through a shared folder; null for the caller's own bookmark. The server always sends it; a client reads an absent value as null"),
    folders: z.array(BookmarkFolderSchema).describe("The caller's folders the bookmark is filed in, in the order of their names; empty when it is filed in none, and always for a bookmark that is shared with the caller"),
    tags: z.array(BookmarkTagSchema).describe("The caller's own tags on the bookmark, in the order of their names; another member's tags are never in it, the owner's among them, and empty when the caller put none on it"),
    version: z.number().int().min(1).describe("Moves by one with every change; the ETag header carries it and If-Match takes it back"),
    createdAt: z.iso.datetime().describe("When the bookmark was created, RFC 3339 UTC"),
    updatedAt: z.iso.datetime().describe("When the bookmark last changed, RFC 3339 UTC"),
  })
  .meta({ id: "Bookmark" });

/** The bookmarks a list, a select-all and a filter of a bulk request cover (doc 02 section 5.7). */
export const BOOKMARK_SCOPES = ["all", "mine", "shared_with_me", "shared_by_me"] as const;

/** The most bookmarks a page returns (doc 04 section 6.1). */
export const BOOKMARK_LIST_MAX_LIMIT = 100;

/** The page size when `limit` is left out (doc 04 section 6.1). */
export const BOOKMARK_LIST_DEFAULT_LIMIT = 48;

/** Where the total of a list stops being counted (Q42). */
export const BOOKMARK_LIST_TOTAL_CAP = 10_000;

/**
 * The longest cursor a client may send back. The largest one the server issues carries the lower-cased title of the last item
 * (300 characters, up to 6 bytes each once JSON-escaped), the identifier and the signature, as base64url: about 2 600 characters.
 */
export const BOOKMARK_CURSOR_MAX_LENGTH = 4096;

export const BookmarkSortSchema = z.enum(["recent", "oldest", "title_asc", "title_desc", "most_used", "recently_opened"]);

const QueryBooleanSchema = z.enum(["true", "false"]);

/** The text query of the list and of the filters that name its bookmarks: plain text, 1 to 100 characters after the whitespace around it is removed. */
const BookmarkTextQuerySchema = z
  .string()
  .trim()
  .min(1)
  .max(SEARCH_QUERY_MAX_LENGTH)
  .describe(
    "Narrows the bookmarks to those the search of the palette finds, by their title, host, slug and description (the path of the URL is not searched): every word of it must be the start of a word of one of them, or of the slug, and a typo is matched only when no bookmark has the words. It is plain text, 1 to 100 characters after the whitespace around it is removed, and `&`, `|`, `!`, `:`, `*`, `%`, `_`, quotes and backslashes are never operators or wildcards. A text of fewer than three characters matches the start of the slug or of the title only. The sort, the keyset and the filters are kept, so the bookmarks are not ranked by relevance. Left out, the text does not filter",
  );

export const ListBookmarksQuerySchema = z.strictObject({
  scope: z
    .enum(BOOKMARK_SCOPES)
    .default("all")
    .describe(
      "Whose bookmarks are listed: all (the caller's own and those shared with them), mine (the caller's own), shared_with_me (other members' bookmarks that are shared with the caller, directly, through a team or through a folder) or shared_by_me (the caller's own that are shared with anyone). A bookmark that can be read through more than one route is listed once. The filters tag and url name the caller's own things and reach the caller's own bookmarks alone, so shared_with_me with one of them lists nothing. The filter folderId reaches the bookmarks filed in the caller's own folder and those filed in a folder of another member that is shared with the caller, so shared_with_me with it lists the latter. A pinned filter means pinned by the caller, so no shared bookmark is pinned. The text query q reaches the bookmarks the caller can read, so with all or shared_with_me it also lists the shared bookmarks it matches and with mine only the caller's own",
    ),
  pinned: QueryBooleanSchema.optional().describe("true lists pinned bookmarks only and false unpinned ones only; left out, pinning is not filtered on"),
  hasSlug: QueryBooleanSchema.optional().describe("true lists bookmarks with a slug only and false those without one; left out, slugs are not filtered on"),
  forwarding: QueryBooleanSchema.optional().describe("true lists the bookmarks /go forwards to only and false those it does not; left out, forwarding is not filtered on"),
  q: BookmarkTextQuerySchema.optional(),
  url: z
    .string()
    .min(1)
    .max(BOOKMARK_URL_MAX_LENGTH)
    .optional()
    .describe(
      "Lists the caller's bookmarks whose canonical URL equals the canonical form of this value, which the duplicate warning of a new bookmark uses. The value is normalised as a bookmark's URL is, and one that cannot be a bookmark's URL is refused with 422",
    ),
  folderId: z
    .uuid()
    .optional()
    .describe("Lists the bookmarks filed in this folder, the caller's own or one of another member's that is shared with the caller. A folder that is another member's and not shared with the caller, another workspace's or unknown lists nothing: an empty page, not an error. Left out, folders are not filtered on"),
  tag: z
    .union([z.uuid(), z.array(z.uuid()).max(BOOKMARK_TAG_FILTER_MAX)])
    .optional()
    .describe(
      "Lists the bookmarks that carry every one of the given tags of the caller's (AND; OR is not offered): repeat the parameter, at most 10 times. Tags are addressed by identifier, so a rename breaks no link. A tag that is another member's, another workspace's or unknown lists nothing: an empty page, not an error. Left out, tags are not filtered on",
    ),
  sort: BookmarkSortSchema.default("recent").describe(
    "The order, with the identifier as the tiebreak: recent (newest first), oldest, title_asc and title_desc (by title, ignoring case), most_used (most opens first) or recently_opened (last opened first, never-opened bookmarks last)",
  ),
  limit: z.coerce.number().int().min(1).max(BOOKMARK_LIST_MAX_LIMIT).default(BOOKMARK_LIST_DEFAULT_LIMIT).describe("The most bookmarks to return, at most 100"),
  cursor: z
    .string()
    .min(1)
    .max(BOOKMARK_CURSOR_MAX_LENGTH)
    .optional()
    .describe("The `nextCursor` of the previous page. It is valid only with the scope, filters (the text query among them) and sort it was issued for, for the account and workspace that received it; any other cursor is refused with 400"),
});

export const BookmarkListSchema = z
  .strictObject({
    items: z.array(BookmarkSchema).describe("One page of the bookmarks the scope covers, in the order asked for; plan-archived bookmarks are never listed"),
    nextCursor: z.string().nullable().describe("Passed as `cursor` to get the next page; null on the last page"),
    total: z.number().int().min(0).nullable().describe("How many bookmarks match the filters, across all pages: exact up to 10 000, and null above that, where totalAtLeast says so"),
    totalAtLeast: z.literal(BOOKMARK_LIST_TOTAL_CAP).optional().describe("Present, and 10 000, when total is null: the filters match more than 10 000 bookmarks"),
  })
  .meta({ id: "BookmarkList" });

/** The most identifiers a bulk request names (doc 04 section 6.2). */
export const BOOKMARK_BULK_IDS_MAX = 1000;

/**
 * The most bookmarks a select-all returns and a bulk request by filter acts on (doc 02 section 16, which doc 04 section 6.2 repeats).
 * It is a fixed value of this release: doc 07 declares no key for it.
 */
export const BOOKMARK_SELECT_ALL_CAP = 5000;

export const BULK_FOLDER_ACTIONS = ["add_to_folder", "move_to_folder", "remove_from_folder"] as const;

export const BULK_TAG_ACTIONS = ["add_tags", "remove_tags"] as const;

export const BULK_BOOKMARK_ACTIONS = ["delete", "pin", "unpin", ...BULK_FOLDER_ACTIONS, ...BULK_TAG_ACTIONS, "share"] as const;

/** The actions `POST /bookmarks/bulk/preview` answers for. */
export const BULK_PREVIEW_ACTIONS = ["add_tags", "share"] as const;

/** The most tags a bulk request adds or removes at once. */
export const BOOKMARK_BULK_TAGS_MAX = 100;

const BookmarkTagFilterSchema = z
  .union([z.uuid(), z.array(z.uuid()).max(BOOKMARK_TAG_FILTER_MAX)])
  .describe(
    "Matches the bookmarks that carry every one of the given tags of the caller's (AND; OR is not offered), at most 10. A tag that is another member's, another workspace's or unknown matches nothing. Left out, tags are not filtered on",
  );

export const BookmarkFilterSchema = z
  .strictObject({
    scope: z
      .enum(BOOKMARK_SCOPES)
      .optional()
      .describe("Whose bookmarks are matched, as the list's scope says; mine when left out. A selection that holds a bookmark shared with the caller is refused by a bulk request with 403, whatever the action"),
    pinned: z.boolean().optional().describe("true matches pinned bookmarks only and false unpinned ones only; left out, pinning is not filtered on"),
    hasSlug: z.boolean().optional().describe("true matches bookmarks with a slug only and false those without one; left out, slugs are not filtered on"),
    forwarding: z.boolean().optional().describe("true matches the bookmarks /go forwards to only and false those it does not; left out, forwarding is not filtered on"),
    q: BookmarkTextQuerySchema.optional(),
    url: z
      .string()
      .min(1)
      .max(BOOKMARK_URL_MAX_LENGTH)
      .optional()
      .describe("Matches the caller's bookmarks whose canonical URL equals the canonical form of this value; one that cannot be a bookmark's URL is refused with 422"),
    folderId: z
      .uuid()
      .optional()
      .describe("Matches the bookmarks filed in this folder, the caller's own or one of another member's that is shared with the caller. A folder that is another member's and not shared with the caller, another workspace's or unknown matches nothing. Left out, folders are not filtered on"),
    tag: BookmarkTagFilterSchema.optional(),
  })
  .meta({ id: "BookmarkFilter" });

const BulkIdsSchema = z
  .array(z.uuid())
  .min(1)
  .max(BOOKMARK_BULK_IDS_MAX)
  .describe("The bookmarks to act on, 1 to 1 000 identifiers; one named twice counts once. Give this or filter, and not both");

const BulkTagIdsSchema = z.array(z.uuid()).min(1).max(BOOKMARK_BULK_TAGS_MAX);

const isOneOf = (actions: readonly string[], action: string): boolean => actions.includes(action);

const BulkShareAccountIdSchema = z.uuid().optional().describe("The member the share action shares the bookmarks with; it must be a current member of the workspace other than the caller. share requires this or teamId, and not both; every other action refuses it");

const BulkShareTeamIdSchema = z.uuid().optional().describe("The team the share action shares the bookmarks with; it must be a team of the workspace. share requires this or accountId, and not both; every other action refuses it");

/** Adds the issues of a share target that is missing, given twice or given for an action that shares nothing. */
function checkShareTarget(request: { readonly action: string; readonly accountId?: string | undefined; readonly teamId?: string | undefined }, context: z.RefinementCtx): void {
  const wantsTarget = request.action === "share";
  const named = (request.accountId === undefined ? 0 : 1) + (request.teamId === undefined ? 0 : 1);
  if (wantsTarget && named !== 1) {
    context.addIssue({ code: "custom", message: "name either accountId or teamId", path: [request.accountId === undefined ? "accountId" : "teamId"] });
  }
  if (!wantsTarget) {
    if (request.accountId !== undefined) {
      context.addIssue({ code: "custom", message: "this action takes no member", path: ["accountId"] });
    }
    if (request.teamId !== undefined) {
      context.addIssue({ code: "custom", message: "this action takes no team", path: ["teamId"] });
    }
  }
}

export const BulkBookmarksRequestSchema = z
  .strictObject({
    action: z
      .enum(BULK_BOOKMARK_ACTIONS)
      .describe(
        "delete removes the bookmarks for good, pin pins them and unpin unpins them. add_to_folder files them in the folder folderId as well as in the folders they are in, move_to_folder files them in that folder alone, and remove_from_folder takes them out of that folder. add_tags puts the tags tagIds on them and remove_tags takes those tags off. share shares them with the member accountId or the team teamId, read-only; only the caller's own bookmarks are shared, it needs the sharing entitlement of the target's kind, and a bookmark the target is shared with already counts as affected",
      ),
    ids: BulkIdsSchema.optional(),
    filter: BookmarkFilterSchema.optional().describe(
      "Acts on the caller's bookmarks that match this filter, which is the list's filters; a filter that matches more than 5 000 bookmarks is refused with 422. Give this or ids, and not both",
    ),
    folderId: z
      .uuid()
      .optional()
      .describe("The caller's folder the three folder actions act with; required for them and refused for every other action. A folder that is another member's, another workspace's or unknown is refused with 404 and nothing is changed"),
    tagIds: BulkTagIdsSchema.optional().describe(
      "The caller's tags add_tags and remove_tags act with, 1 to 100 identifiers; required for them and refused for every other action. A tag that is another member's, another workspace's or unknown is refused with 404 and nothing is changed",
    ),
    accountId: BulkShareAccountIdSchema,
    teamId: BulkShareTeamIdSchema,
  })
  .superRefine((request, context) => {
    checkShareTarget(request, context);
    if ((request.ids === undefined) === (request.filter === undefined)) {
      context.addIssue({ code: "custom", message: "name either ids or filter" });
    }
    const wantsFolder = isOneOf(BULK_FOLDER_ACTIONS, request.action);
    const wantsTags = isOneOf(BULK_TAG_ACTIONS, request.action);
    if (wantsFolder !== (request.folderId !== undefined)) {
      context.addIssue({ code: "custom", message: wantsFolder ? "name the folder" : "this action takes no folder", path: ["folderId"] });
    }
    if (wantsTags !== (request.tagIds !== undefined)) {
      context.addIssue({ code: "custom", message: wantsTags ? "name the tags" : "this action takes no tags", path: ["tagIds"] });
    }
  })
  .meta({ id: "BulkBookmarksRequest" });

const BulkSkippedReasonsSchema = z
  .strictObject({
    not_owner: z.number().int().min(0).describe("Bookmarks the caller can read and does not own; always 0, since a selection that holds one is refused as a whole with 403"),
    not_found: z
      .number()
      .int()
      .min(0)
      .describe("Bookmarks the caller owns none of in this workspace: another member's, one whose owner has left the workspace, another workspace's, one that is gone, and, for every action but delete, a plan-archived one. They are not told apart"),
  })
  .describe("The skipped bookmarks by reason, as counts only");

export const BulkBookmarksResultSchema = z
  .strictObject({
    requested: z.number().int().min(0).describe("How many bookmarks the request named (the distinct identifiers) or the filter matched"),
    affected: z
      .number()
      .int()
      .min(0)
      .describe("How many of them are now deleted, or are in the state the action asks for: pinned or unpinned, filed in or out of the folder, tagged or untagged (a bookmark that already was is counted)"),
    skipped: z.number().int().min(0).describe("How many were left alone: requested minus affected"),
    skippedReasons: BulkSkippedReasonsSchema,
  })
  .meta({ id: "BulkBookmarksResult" });

export const BulkBookmarksPreviewRequestSchema = z
  .strictObject({
    action: z.enum(BULK_PREVIEW_ACTIONS).describe("The action to preview: add_tags, or share"),
    ids: BulkIdsSchema.optional(),
    filter: BookmarkFilterSchema.optional().describe(
      "Previews on the caller's bookmarks that match this filter, which is the list's filters; a filter that matches more than 5 000 bookmarks is refused with 422. Give this or ids, and not both",
    ),
    tagIds: BulkTagIdsSchema.optional().describe(
      "The caller's tags add_tags would put on the bookmarks, 1 to 100 identifiers; required for add_tags and refused for share. A tag that is another member's, another workspace's or unknown is refused with 404",
    ),
    accountId: BulkShareAccountIdSchema,
    teamId: BulkShareTeamIdSchema,
  })
  .superRefine((request, context) => {
    checkShareTarget(request, context);
    if ((request.ids === undefined) === (request.filter === undefined)) {
      context.addIssue({ code: "custom", message: "name either ids or filter" });
    }
    if ((request.action === "add_tags") !== (request.tagIds !== undefined)) {
      context.addIssue({ code: "custom", message: request.action === "add_tags" ? "name the tags" : "this action takes no tags", path: ["tagIds"] });
    }
  })
  .meta({ id: "BulkBookmarksPreviewRequest" });

export const BulkPreviewTagSchema = z
  .strictObject({
    id: z.uuid().describe("The tag's identifier"),
    name: z.string().describe("The tag's name, in the case it was entered in"),
    bookmarkCount: z.number().int().min(0).describe("How many of the bookmarks the action would reach carry the tag afterwards"),
    added: z.number().int().min(0).describe("How many of them get the tag from the action: those that do not carry it yet"),
  })
  .meta({ id: "BulkPreviewTag" });

export const BulkPreviewAudienceSchema = z
  .strictObject({
    kind: z.enum(SHARE_TARGET_KINDS).describe("What the bookmarks would be shared with: a member of the workspace, or one of its teams"),
    id: z.uuid().describe("The account identifier of the member, or the identifier of the team"),
    name: z.string().describe("The member's display name or the team's name"),
    memberCount: z.number().int().min(0).describe("How many members other than the caller can read the bookmarks through this target: 1 for a member, the members of the team without the caller for a team"),
    added: z.number().int().min(0).describe("How many of the bookmarks the action would reach are not shared with the target yet, so get a share from the action"),
  })
  .meta({ id: "BulkPreviewAudience" });

export const BulkBookmarksPreviewSchema = z
  .strictObject({
    requested: z.number().int().min(0).describe("How many bookmarks the request named (the distinct identifiers) or the filter matched"),
    affected: z.number().int().min(0).describe("How many of them the action would reach: the caller's own bookmarks that are not plan-archived"),
    skipped: z.number().int().min(0).describe("How many it would leave alone: requested minus affected"),
    skippedReasons: BulkSkippedReasonsSchema,
    tags: z
      .array(BulkPreviewTagSchema)
      .describe("For add_tags, the tags the bookmarks the action would reach carry afterwards, in the order of their names: the tags they carry now and the tags the action adds; empty for share"),
    audience: BulkPreviewAudienceSchema.nullable().describe("For share, who the bookmarks the action would reach are shared with afterwards; null for add_tags"),
  })
  .meta({ id: "BulkBookmarksPreview" });

export const BookmarkIdsQuerySchema = ListBookmarksQuerySchema.omit({ sort: true, limit: true, cursor: true });

export const BookmarkIdsSchema = z
  .strictObject({
    ids: z.array(z.uuid()).max(BOOKMARK_SELECT_ALL_CAP).describe("The identifiers of the bookmarks the scope covers that match the filters, newest first, at most 5 000"),
    truncated: z.boolean().describe("true when more than 5 000 bookmarks match, so ids holds the first 5 000 only and a bulk request by the same filter is refused"),
  })
  .meta({ id: "BookmarkIds" });

export const BookmarkOpenSchema = z
  .strictObject({
    url: z.string().describe("The destination to go to: the bookmark's URL as stored, checked again to be an http or https URL"),
  })
  .meta({ id: "BookmarkOpen" });

export const SLUG_AVAILABILITY_STATUSES = ["available", "taken_by_me", "invalid"] as const;

export const SlugAvailabilityQuerySchema = z.strictObject({
  slug: z
    .string()
    .describe("The slug to check. It is trimmed and lower-cased before it is judged; one that is empty or outside the grammar answers invalid, not an error"),
  bookmarkId: z
    .uuid()
    .optional()
    .describe("The caller's bookmark the slug is being set on: that bookmark's own current slug answers available. A bookmark that is another member's, another workspace's or unknown is refused with 404. Left out, the slug is judged for a new bookmark"),
});

export const SlugAvailabilitySchema = z
  .strictObject({
    status: z
      .enum(SLUG_AVAILABILITY_STATUSES)
      .describe("available: the caller can use the slug; taken_by_me: the caller already uses it on another bookmark of the workspace; invalid: it is outside the grammar"),
    othersUseCount: z
      .number()
      .int()
      .min(0)
      .describe("How many bookmarks of other members of the workspace, and of members who have left it, have the slug and are not plan-archived: a count only, for the collision hint. 0 for an invalid slug"),
  })
  .meta({ id: "SlugAvailability" });

export const BookmarkMetadataRequestSchema = z
  .strictObject({
    url: z
      .string()
      .min(1)
      .max(BOOKMARK_URL_MAX_LENGTH)
      .describe(
        "The address of the page to read the title and description of: an http or https URL of at most 2 048 characters, judged as a bookmark's URL is. Any other scheme is refused with 422 url_not_allowed",
      ),
  })
  .meta({ id: "BookmarkMetadataRequest" });

export const BookmarkMetadataSchema = z
  .strictObject({
    title: z.string().nullable().describe("The page's title (its og:title, else its title element), plain text of at most 300 characters; null when the page gave none"),
    description: z.string().nullable().describe("The page's description (its og:description, else its description meta tag), plain text of at most 1 000 characters; null when the page gave none"),
    siteName: z.string().nullable().describe("The page's site name (its og:site_name), plain text of at most 100 characters; null when the page gave none"),
    canonicalUrl: z.string().nullable().describe("The page's own canonical link, an absolute http or https URL without credentials, as text and never fetched; null when the page gave none"),
    language: z.string().nullable().describe("The page's language tag, such as en or de-AT; null when the page gave none"),
    cached: z.boolean().describe("Whether the answer is the workspace's cached result of an earlier fetch of this page, which expires seven days after it was fetched, and not a fetch made for this request"),
  })
  .meta({ id: "BookmarkMetadata" });

export const BookmarkParamsSchema = z.strictObject({
  id: z.uuid().describe("The bookmark's identifier"),
});

/** The precondition of doc 04 section 2.4: the `ETag` of the version the caller read, as a quoted entity tag, or `*`. */
export const BookmarkIfMatchHeaderSchema = z.object({
  "If-Match": z
    .string()
    .optional()
    .describe('The ETag of the version the change is made against, for example "3". A bookmark at another version answers 412 precondition_failed. Optional, so an API token may leave it out; `*` matches any version'),
});

const BookmarkEntityTag = {
  ETag: { description: 'The bookmark\'s version as an entity tag, for example "3"; the If-Match of the next change', schema: z.string() },
} as const;

export const createBookmark = defineOperation({
  method: "post",
  path: "/api/v1/bookmarks",
  operationId: "createBookmark",
  tag: "bookmarks",
  summary: "Create a bookmark",
  auth: "member",
  rate: "write",
  scope: "write",
  idempotency: true,
  request: { body: CreateBookmarkRequestSchema },
  responses: {
    201: jsonResponse(
      "The bookmark, owned by the caller and private to them, filed in the folders folderIds named and tagged with the tags tagIds and tagNames named, with its id and its version in the body (the ETag of a later read repeats the version). The workspace's bookmark count is raised by one in the same transaction, and bookmark.created is announced once it is committed. A retry with the same Idempotency-Key and the same request answers this response again with Idempotency-Replayed: true and stores nothing; a replay restores the status and the body and no header, so the response carries none",
      BookmarkSchema,
    ),
    400: problemResponse("The request was malformed, or the Idempotency-Key header is not a UUID"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    403: problemResponse("The request did not come from the application itself (cross_site_request), or the credential is an API token that may only read (token_scope)"),
    404: problemResponse(
      "The request acts in no workspace: the account has none, or the workspace is being deleted; or a folder of folderIds or a tag of tagIds is not one the caller has in it (another member's, another workspace's or unknown), and nothing is created",
    ),
    409: problemResponse(
      "The Idempotency-Key was used before for another request (idempotency_conflict), or the caller already uses the slug on another bookmark of the workspace (slug_taken, errors on slug), also when two requests set it at once; nothing is written",
    ),
    422: problemResponse(
      "The body did not pass validation (a missing, empty or over-long URL, title or description, a title, description or tag name that holds a NUL character, a malformed URL, a slug outside the grammar, forwarding true without a slug, a folderIds, tagIds or tagNames list of more than 100 or with a malformed identifier, or a tag name that is empty or over 40 characters, or a field the operation does not declare), the URL is not an http or https URL (url_not_allowed), or the workspace already holds as many bookmarks as its bookmarks.max entitlement allows (bookmark_limit_reached; the problem carries limit and used). Nothing is written, and a refused request keeps no key, so a retry with it runs",
    ),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse(
      "The service is temporarily unavailable, the entitlement source could not say how many bookmarks the workspace may hold, or an earlier request with the same Idempotency-Key is still running",
    ),
  },
});

export const listBookmarks = defineOperation({
  method: "get",
  path: "/api/v1/bookmarks",
  operationId: "listBookmarks",
  tag: "bookmarks",
  summary: "List bookmarks",
  auth: "member",
  rate: "read",
  scope: "read",
  request: { query: ListBookmarksQuerySchema },
  responses: {
    200: jsonResponse(
      "One page of the bookmarks the scope covers in the order asked for, with the cursor of the next page and the total the filters match (exact up to 10 000, then null with totalAtLeast). Another member's bookmarks that are not shared with the caller, those of another workspace and plan-archived ones are never listed. A bookmark of another member carries its owner and how it is shared with the caller, and none of the owner's folders, tags or pin",
      BookmarkListSchema,
    ),
    400: problemResponse("The request was malformed, or the cursor is not one this account was issued for this workspace, these filters and this sort (bad_request)"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    404: problemResponse("The request acts in no workspace: the account has none, or the workspace is being deleted"),
    422: problemResponse("The query did not pass validation (an unknown parameter or sort, a boolean other than true or false, a folderId or a tag that is not an identifier, more than 10 tags, a q that is empty or over 100 characters, a limit outside 1 to 100), or the url is not a URL a bookmark can have"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const getBookmark = defineOperation({
  method: "get",
  path: "/api/v1/bookmarks/{id}",
  operationId: "getBookmark",
  tag: "bookmarks",
  summary: "Read a bookmark",
  auth: "member",
  rate: "read",
  scope: "read",
  request: { params: BookmarkParamsSchema },
  responses: {
    200: jsonResponse(
      "The caller's bookmark, or a bookmark of another member that is shared with the caller, directly, through a team or through a folder. The latter carries its owner (the display name, null once the owner has left the workspace) and how it is shared with the caller, and nothing of the owner's tags, folders or pin and no list of the others it is shared with",
      BookmarkSchema,
      { headers: BookmarkEntityTag },
    ),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    404: problemResponse(
      "The workspace the request acts in has no bookmark with this identifier that the caller can read: another member's bookmark that is not shared with the caller, a bookmark whose owner has left the workspace and that is not shared with the caller, a plan-archived one, a bookmark of another workspace and one that never existed are answered alike",
    ),
    422: problemResponse("The identifier did not pass validation"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const updateBookmark = defineOperation({
  method: "patch",
  path: "/api/v1/bookmarks/{id}",
  operationId: "updateBookmark",
  tag: "bookmarks",
  summary: "Change a bookmark",
  auth: "member",
  rate: "write",
  scope: "write",
  request: { params: BookmarkParamsSchema, headers: BookmarkIfMatchHeaderSchema, body: UpdateBookmarkRequestSchema },
  responses: {
    200: jsonResponse(
      "The caller's bookmark after a JSON Merge Patch of its url, title, description, pinned, slug, forwarding, folderIds, tagIds and tagNames fields. A change moves the version by one and the ETag is that of the new version; a patch that names the values the bookmark has, in the folders it is already in and with the tags it already has, and an empty one, write nothing and answer with the unchanged version; a patch of folderIds, tagIds or tagNames alone changes the folders or the tags and keeps the version",
      BookmarkSchema,
      { headers: BookmarkEntityTag },
    ),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    403: problemResponse(
      "The request did not come from the application itself (cross_site_request), or the credential is an API token that may only read (token_scope), or the bookmark is shared with the caller, who does not own it, can read it and may not change it, tag it or file it (forbidden): another member's, or one whose owner has left the workspace and that is still shared with them; a plan-archived bookmark is not counted as shared, and nothing is changed",
    ),
    404: problemResponse(
      "The workspace the request acts in has no bookmark of the caller with this identifier that can be changed and none shared with the caller: another member's bookmark that is not shared with them, a bookmark whose owner has left the workspace and that is not shared with them, a bookmark of another workspace, a plan-archived one and one that never existed are answered alike. A folder of folderIds or a tag of tagIds that is not the caller's (another member's, another workspace's or unknown) is answered alike, and nothing is changed",
    ),
    409: problemResponse("The caller already uses the slug on another bookmark of the workspace (slug_taken, errors on slug), also when two requests set it at once; nothing is written"),
    412: problemResponse("If-Match names a version other than the bookmark's current one (precondition_failed); the bookmark is unchanged"),
    422: problemResponse(
      "The identifier or the body did not pass validation (a malformed, empty or over-long URL, a title that is blank, over-long or holding a NUL character, a description over 1 000 characters or holding one, a null title or URL, a slug outside the grammar, forwarding true or left on without a slug, a folderIds, tagIds or tagNames list of more than 100 or with a malformed identifier, or a tag name that is empty or over 40 characters, or a field the operation does not declare), or the URL is not an http or https URL (url_not_allowed). Nothing is written",
    ),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const deleteBookmark = defineOperation({
  method: "delete",
  path: "/api/v1/bookmarks/{id}",
  operationId: "deleteBookmark",
  tag: "bookmarks",
  summary: "Delete a bookmark",
  auth: "member",
  rate: "write",
  scope: "write",
  request: { params: BookmarkParamsSchema },
  responses: {
    204: emptyResponse(
      "The bookmark is deleted for good: the rows that reference it (folder and tag links, shares, go preferences) go with it, its slug is free at once, and the workspace's bookmark count falls by one unless the bookmark was plan-archived",
    ),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    403: problemResponse(
      "The request did not come from the application itself (cross_site_request), or the credential is an API token that may only read (token_scope), or the bookmark is shared with the caller, who does not own it, can read it and may not delete it (forbidden): another member's, or one whose owner has left the workspace and that is still shared with them; a plan-archived bookmark is not counted as shared, and nothing is deleted",
    ),
    404: problemResponse(
      "The workspace the request acts in has no bookmark of the caller with this identifier and none shared with them: another member's bookmark that is not shared with the caller, a bookmark whose owner has left the workspace and that is not shared with the caller, a plan-archived one that is not the caller's, a bookmark of another workspace, one that never existed and one that was deleted before are answered alike, since a hard delete keeps no tombstone and a repeat is not answered 204",
    ),
    422: problemResponse("The identifier did not pass validation"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const openBookmark = defineOperation({
  method: "post",
  path: "/api/v1/bookmarks/{id}/open",
  operationId: "openBookmark",
  tag: "bookmarks",
  summary: "Record an open of a bookmark",
  auth: "member",
  rate: "go",
  scope: "write",
  request: { params: BookmarkParamsSchema },
  responses: {
    200: jsonResponse(
      "The destination of the bookmark, which is the caller's own or another member's that is shared with the caller. The open is counted asynchronously, on the bookmark itself, so the owner sees the total of everyone's opens: the bookmark's open count and last opened time follow within seconds, and only that count and the latest time are kept, with no history, referrer or address",
      BookmarkOpenSchema,
    ),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    403: problemResponse("The request did not come from the application itself (cross_site_request), or the credential is an API token that may only read (token_scope)"),
    404: problemResponse(
      "The workspace the request acts in has no bookmark with this identifier that the caller can read: another member's bookmark that is not shared with the caller, a bookmark whose owner has left the workspace and that is not shared with the caller, a bookmark of another workspace, a plan-archived one and one that never existed are answered alike, and nothing is counted",
    ),
    422: problemResponse("The identifier did not pass validation, or the stored URL is not an http or https URL (url_not_allowed); nothing is counted"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const listBookmarkIds = defineOperation({
  method: "get",
  path: "/api/v1/bookmarks/ids",
  operationId: "listBookmarkIds",
  tag: "bookmarks",
  summary: "List the identifiers of the bookmarks a filter matches",
  auth: "member",
  rate: "read",
  scope: "read",
  request: { query: BookmarkIdsQuerySchema },
  responses: {
    200: jsonResponse(
      "The identifiers of the bookmarks the scope covers that match the filters of the list, newest first, up to the select-all cap of 5 000, and whether more matched. Another member's bookmarks that are not shared with the caller, those of another workspace and plan-archived ones are never returned",
      BookmarkIdsSchema,
    ),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    404: problemResponse("The request acts in no workspace: the account has none, or the workspace is being deleted"),
    422: problemResponse("The query did not pass validation (an unknown parameter, a boolean other than true or false, a malformed folderId or tag, more than 10 tags, a q that is empty or over 100 characters), or the url is not a URL a bookmark can have"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const bulkBookmarks = defineOperation({
  method: "post",
  path: "/api/v1/bookmarks/bulk",
  operationId: "bulkBookmarks",
  tag: "bookmarks",
  summary: "Delete, pin, unpin, file, tag or share many bookmarks",
  auth: "member",
  rate: "bulk",
  scope: "write",
  request: { body: BulkBookmarksRequestSchema },
  responses: {
    200: jsonResponse(
      "What the request did, as counts only. The whole request is one transaction: every bookmark it affects changes or none does. Only the caller's own bookmarks change; the others are skipped as not_found without saying whether they exist, and a selection that holds one shared with the caller is refused as a whole with 403. A delete gives the workspace's bookmark count back once for the request, by the bookmarks that were not plan-archived, and records one bookmark.bulk_deleted audit event with the number deleted, never a title or a URL. Filing and tagging write links only: they move no bookmark's version, record no audit event, and leave a plan-archived bookmark alone. A share action grants a read-only share of each bookmark it reaches to the member or team, once for a target a bookmark is shared with already, and records one share.bulk_granted audit event with the number of shares it made and the target, none when it made none",
      BulkBookmarksResultSchema,
    ),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    403: problemResponse(
      "The request did not come from the application itself (cross_site_request), or the credential is an API token that may only read (token_scope), or the selection holds a bookmark that is shared with the caller, who does not own it, can read it and may not act on it (forbidden): another member's, or one whose owner has left the workspace and that is still shared with them; a plan-archived bookmark is not counted as shared and is skipped as not_found; or a share action for a workspace that does not hold the entitlement of the target's kind: sharing.members for a member, sharing.teams for a team (entitlement_required; the problem carries entitlement and upgradeAvailable); nothing is changed",
    ),
    404: problemResponse(
      "The request acts in no workspace: the account has none, or the workspace is being deleted; or the folder of a folder action or a tag of a tag action is not one the caller has in it (another member's, another workspace's or unknown), and nothing is changed",
    ),
    422: problemResponse(
      "The body did not pass validation (an unknown action, neither or both of ids and filter, no identifier or more than 1 000, a malformed identifier, a folder action without folderId or a tag action without tagIds, a folderId or tagIds on an action that takes none, more than 100 tags, a share without accountId and teamId or with both, an accountId or teamId on another action, a filter q that is empty or over 100 characters, a field the operation does not declare), the filter's url is not a URL a bookmark can have, the filter matches more than the select-all cap of 5 000 bookmarks, or a share action's target is the caller (cannot_share_with_self on accountId), an account that is no current member of the workspace (unknown_member on accountId) or a team of no team of the workspace (unknown_team on teamId). Nothing is written",
    ),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const previewBulkBookmarks = defineOperation({
  method: "post",
  path: "/api/v1/bookmarks/bulk/preview",
  operationId: "previewBulkBookmarks",
  tag: "bookmarks",
  summary: "Preview adding tags to, or sharing, many bookmarks",
  auth: "member",
  rate: "read",
  scope: "write",
  request: { body: BulkBookmarksPreviewRequestSchema },
  responses: {
    200: jsonResponse(
      "What add_tags or share with the same body would do, without writing anything: the counts as the bulk request reports them, and the tag set the bookmarks it reaches would carry afterwards; share does the same for who the bookmarks would be shared with (audience). Only the caller's own bookmarks are counted; the others are skipped as not_found without saying whether they exist",
      BulkBookmarksPreviewSchema,
    ),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    403: problemResponse(
      "The request did not come from the application itself (cross_site_request), or the credential is an API token that may only read (token_scope): the preview is a POST, so it takes the write scope though it writes nothing; or the selection holds a bookmark that is shared with the caller, who does not own it and may not act on it (forbidden): another member's, or one whose owner has left the workspace and that is still shared with them; a plan-archived bookmark is not counted as shared and is skipped as not_found; or a share preview for a workspace that does not hold the entitlement of the target's kind: sharing.members for a member, sharing.teams for a team (entitlement_required; the problem carries entitlement and upgradeAvailable)",
    ),
    404: problemResponse(
      "The request acts in no workspace: the account has none, or the workspace is being deleted; or a tag of tagIds is not one the caller has in it (another member's, another workspace's or unknown)",
    ),
    422: problemResponse(
      "The body did not pass validation (an action other than add_tags or share, neither or both of ids and filter, no identifier or more than 1 000, add_tags without tags or share with tags, more than 100 tags, a malformed identifier, a share without accountId and teamId or with both, an accountId or teamId on add_tags, a filter q that is empty or over 100 characters, a field the operation does not declare), the filter's url is not a URL a bookmark can have, the filter matches more than the select-all cap of 5 000 bookmarks, or a share target that is the caller, no current member of the workspace or no team of it",
    ),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const checkSlugAvailability = defineOperation({
  method: "get",
  path: "/api/v1/slugs/availability",
  operationId: "checkSlugAvailability",
  tag: "bookmarks",
  summary: "Check whether a slug is free",
  auth: "member",
  rate: "read",
  scope: "read",
  request: { query: SlugAvailabilityQuerySchema },
  responses: {
    200: jsonResponse(
      "Whether the caller can use the slug in the workspace: available, taken_by_me when another bookmark of the caller's already has it, or invalid when it is outside the grammar, with the number of other bookmarks that have it (a count, never whose). The caller's own bookmark named by bookmarkId is not counted against its own slug",
      SlugAvailabilitySchema,
    ),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    404: problemResponse(
      "The request acts in no workspace: the account has none, or the workspace is being deleted; or the workspace has no bookmark of the caller with the identifier bookmarkId (another member's, another workspace's or unknown, answered alike)",
    ),
    422: problemResponse("The query did not pass validation (no slug, a bookmarkId that is not an identifier, a parameter the operation does not declare)"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const fetchBookmarkMetadata = defineOperation({
  method: "post",
  path: "/api/v1/bookmarks/metadata",
  operationId: "fetchBookmarkMetadata",
  tag: "bookmarks",
  summary: "Read the title and description of a page",
  auth: "member",
  rate: "fetch",
  scope: "write",
  request: { body: BookmarkMetadataRequestSchema },
  responses: {
    200: jsonResponse(
      "What the page says about itself, from the workspace's cached result when it has not expired or from a fetch made for this request, which is then cached for the workspace for seven days. The fetch goes through the egress adapter, reads at most the first 512 KiB of an HTML page and is answered within 3 seconds at the latest. A field the page does not give is null. Nothing of any bookmark is changed",
      BookmarkMetadataSchema,
    ),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    403: problemResponse("The request did not come from the application itself (cross_site_request), or the credential is an API token that may only read (token_scope)"),
    404: problemResponse("The request acts in no workspace: the account has none, or the workspace is being deleted"),
    422: problemResponse(
      "The body did not pass validation (a missing, empty, over-long or malformed URL, or a field the operation does not declare), or the URL is not one that can be fetched (url_not_allowed): not an http or https URL, or an address the server refuses to connect to (a private, loopback, link-local, carrier-grade NAT or cloud-metadata address, also behind a redirect or a host name). Nothing is cached",
    ),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    502: problemResponse(
      "The page could not be read (upstream_failed): the connection failed, the fetch did not finish within 3 seconds, the status was not a success, or the body was not an HTML page. Nothing is cached",
    ),
    503: problemResponse("The service is temporarily unavailable"),
  },
});
