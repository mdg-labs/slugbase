import { initContract } from "@ts-rest/core";
import { z } from "zod";

const c = initContract();

export const ShareGrantKindSchema = z.enum(["user", "team"]);

export const ShareGrantSchema = z
  .object({
    id: z.string(),
    kind: ShareGrantKindSchema,
    targetId: z.string(),
    targetName: z.string(),
    createdAt: z.string().datetime(),
  })
  .strict();

export const ShareGrantListSchema = z
  .object({
    grants: z.array(ShareGrantSchema),
  })
  .strict();

export const GrantShareBodySchema = z
  .object({
    kind: ShareGrantKindSchema,
    targetId: z.string(),
  })
  .strict();

export const ShareTargetMemberSchema = z
  .object({
    userId: z.string(),
    name: z.string(),
    email: z.string(),
  })
  .strict();

export const ShareTargetTeamSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    memberCount: z.number().int().nonnegative(),
  })
  .strict();

export const ShareTargetsSchema = z
  .object({
    members: z.array(ShareTargetMemberSchema),
    teams: z.array(ShareTargetTeamSchema),
  })
  .strict();

export type ShareGrant = z.infer<typeof ShareGrantSchema>;
export type ShareGrantList = z.infer<typeof ShareGrantListSchema>;
export type GrantShareBody = z.infer<typeof GrantShareBodySchema>;
export type ShareTargets = z.infer<typeof ShareTargetsSchema>;

const errorSchema = z.object({ message: z.string() }).strict();
const resourceParams = z.object({ id: z.string() });
const grantParams = z.object({ id: z.string(), grantId: z.string() });

export const sharingContract = c.router({
  listShareTargets: {
    method: "GET",
    path: "/sharing/targets",
    responses: {
      200: ShareTargetsSchema,
      403: errorSchema,
    },
    summary: "List workspace members and teams available as share targets",
  },
  listBookmarkShares: {
    method: "GET",
    path: "/sharing/bookmarks/:id",
    pathParams: resourceParams,
    responses: {
      200: ShareGrantListSchema,
      403: errorSchema,
      404: errorSchema,
    },
    summary: "List share grants on a bookmark (owner only)",
  },
  grantBookmarkShare: {
    method: "POST",
    path: "/sharing/bookmarks/:id/grants",
    pathParams: resourceParams,
    body: GrantShareBodySchema,
    responses: {
      201: ShareGrantSchema,
      400: errorSchema,
      403: errorSchema,
      404: errorSchema,
    },
    summary: "Grant bookmark access to a member or team (owner only)",
  },
  revokeBookmarkShare: {
    method: "DELETE",
    path: "/sharing/bookmarks/:id/grants/:grantId",
    pathParams: grantParams,
    body: c.noBody(),
    responses: {
      204: c.noBody(),
      403: errorSchema,
      404: errorSchema,
    },
    summary: "Revoke a bookmark share grant (owner only)",
  },
  listFolderShares: {
    method: "GET",
    path: "/sharing/folders/:id",
    pathParams: resourceParams,
    responses: {
      200: ShareGrantListSchema,
      403: errorSchema,
      404: errorSchema,
    },
    summary: "List share grants on a folder (owner only)",
  },
  grantFolderShare: {
    method: "POST",
    path: "/sharing/folders/:id/grants",
    pathParams: resourceParams,
    body: GrantShareBodySchema,
    responses: {
      201: ShareGrantSchema,
      400: errorSchema,
      403: errorSchema,
      404: errorSchema,
    },
    summary: "Grant folder access to a member or team (owner only)",
  },
  revokeFolderShare: {
    method: "DELETE",
    path: "/sharing/folders/:id/grants/:grantId",
    pathParams: grantParams,
    body: c.noBody(),
    responses: {
      204: c.noBody(),
      403: errorSchema,
      404: errorSchema,
    },
    summary: "Revoke a folder share grant (owner only)",
  },
});
