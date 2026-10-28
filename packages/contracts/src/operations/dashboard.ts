import { z } from "zod";
import { defineOperation, jsonResponse, problemResponse, rateLimitedResponse } from "./define.ts";

// The dashboard tag of doc 04 section 10.8 (doc 02 section 9.3, doc 03 section 2): what the home screen shows, in one round trip. It acts in the workspace the request is bound to and
// names none (D11), answers the caller's own bookmarks, folders and tags only, and never counts or lists a plan-archived bookmark (doc 10 T1 and T2). It is the session's alone: it
// declares no token scope, so an API token is refused before the handler.

/** The most bookmarks the quick access holds (doc 02 section 9.3). */
export const DASHBOARD_QUICK_ACCESS_LIMIT = 8;

/** The most pinned bookmarks the dashboard holds (doc 02 section 9.3). */
export const DASHBOARD_PINNED_LIMIT = 12;

/** The most tags the dashboard holds (doc 02 section 9.3). */
export const DASHBOARD_TOP_TAGS_LIMIT = 12;

export const DashboardCountsSchema = z
  .strictObject({
    bookmarks: z.number().int().min(0).describe("The caller's own bookmarks that are not plan-archived"),
    folders: z.number().int().min(0).describe("The caller's own folders"),
    tags: z.number().int().min(0).describe("The caller's own tags"),
    sharedWithYou: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe("The bookmarks shared with the caller; null while sharing is not available, and whenever the caller's workspace does not hold the sharing entitlements"),
  })
  .meta({ id: "DashboardCounts" });

export const DashboardBookmarkSchema = z
  .strictObject({
    id: z.uuid().describe("The bookmark's identifier"),
    title: z.string().describe("The bookmark's title"),
    url: z.string().describe("The URL as stored: normalised, and always http or https"),
    host: z.string().describe("The host name of the URL, lower case and in punycode"),
    slug: z.string().nullable().describe("The bookmark's slug, null when it has none"),
    forwarding: z.boolean().describe("Whether /go forwards to the bookmark by its slug"),
    openCount: z.number().int().min(0).describe("How many times the bookmark was opened"),
  })
  .meta({ id: "DashboardBookmark" });

export const DashboardTagSchema = z
  .strictObject({
    id: z.uuid().describe("The tag's identifier"),
    name: z.string().describe("The tag's name, in the case it was entered in"),
    bookmarkCount: z.number().int().min(0).describe("The caller's bookmarks that carry the tag and are not plan-archived"),
  })
  .meta({ id: "DashboardTag" });

export const DashboardSharingSchema = z
  .strictObject({
    sharedWithYou: z.number().int().min(0).describe("The bookmarks other members shared with the caller"),
    sharedByYou: z.number().int().min(0).describe("The caller's bookmarks that are shared with others"),
  })
  .meta({ id: "DashboardSharing" });

export const DashboardOnboardingSchema = z
  .strictObject({
    bookmarkAdded: z.boolean().describe("Whether the caller owns a bookmark; read from the bookmarks, plan-archived ones included"),
    slugGiven: z.boolean().describe("Whether one of the caller's bookmarks has a slug; read from the bookmarks, plan-archived ones included"),
    browserSetupDone: z.boolean().describe("Whether the caller marked the browser search engine as set up; the stored onboarding state of the account, which PATCH /me changes"),
    folderCreated: z.boolean().describe("Whether the caller owns a folder"),
    importDone: z.boolean().describe("Whether the caller's import from the browser is done; the stored onboarding state of the account, which PATCH /me changes"),
    dismissed: z.boolean().describe("Whether the caller dismissed the Getting started checklist; the stored onboarding state of the account, which PATCH /me changes"),
  })
  .meta({ id: "DashboardOnboarding" });

export const DashboardSchema = z
  .strictObject({
    counts: DashboardCountsSchema,
    quickAccess: z
      .array(DashboardBookmarkSchema)
      .max(DASHBOARD_QUICK_ACCESS_LIMIT)
      .describe("Up to 8 of the caller's own bookmarks that forward by a slug, the most opened first; a bookmark the caller cannot read, one that does not forward and a plan-archived one are never in it"),
    pinned: z
      .array(DashboardBookmarkSchema)
      .max(DASHBOARD_PINNED_LIMIT)
      .describe("Up to 12 of the caller's own pinned bookmarks, the most recently pinned first; plan-archived bookmarks are never in it"),
    topTags: z
      .array(DashboardTagSchema)
      .max(DASHBOARD_TOP_TAGS_LIMIT)
      .describe("Up to 12 of the caller's own tags, the one on the most bookmarks first, then by name; another member's tags are never in it"),
    sharing: DashboardSharingSchema.nullable().describe("The sharing counts; null while sharing is not available, and whenever the caller's workspace does not hold the sharing entitlements"),
    onboarding: DashboardOnboardingSchema,
  })
  .meta({ id: "Dashboard" });

export const getDashboard = defineOperation({
  method: "get",
  path: "/api/v1/dashboard",
  operationId: "getDashboard",
  tag: "dashboard",
  summary: "Read the dashboard",
  auth: "member",
  rate: "read",
  responses: {
    200: jsonResponse("The caller's counts, quick access, pinned bookmarks, top tags, sharing counts and Getting started checklist in the active workspace", DashboardSchema),
    401: problemResponse("There is no session, or its second factor is not complete"),
    403: problemResponse("The credential is an API token, which cannot read the dashboard (forbidden)"),
    404: problemResponse("The request acts in no workspace: the account has none, or the workspace is being deleted"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});
