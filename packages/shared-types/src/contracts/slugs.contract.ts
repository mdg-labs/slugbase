import { initContract } from "@ts-rest/core";
import { z } from "zod";

const c = initContract();

const slugParamSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "Invalid slug format");

export const GoCandidateSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    url: z.string(),
    ownerUserId: z.string(),
  })
  .strict();

export const GoDisambiguationSchema = z
  .object({
    kind: z.literal("disambiguation"),
    slug: slugParamSchema,
    candidates: z.array(GoCandidateSchema),
  })
  .strict();

export const SlugPreferenceSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    userId: z.string(),
    slug: slugParamSchema,
    bookmarkId: z.string(),
    createdAt: z.string().datetime(),
    bookmarkTitle: z.string(),
    bookmarkUrl: z.string(),
    ownerUserId: z.string(),
    isAmbiguous: z.boolean(),
  })
  .strict();

export const SlugPreferenceListSchema = z
  .object({
    items: z.array(SlugPreferenceSchema),
  })
  .strict();

export const ChooseSlugBodySchema = z
  .object({
    bookmarkId: z.string(),
    remember: z.boolean().optional(),
  })
  .strict();

const errorSchema = z.object({ message: z.string() }).strict();

export type GoCandidate = z.infer<typeof GoCandidateSchema>;
export type GoDisambiguation = z.infer<typeof GoDisambiguationSchema>;
export type SlugPreference = z.infer<typeof SlugPreferenceSchema>;
export type ChooseSlugBody = z.infer<typeof ChooseSlugBodySchema>;

export const slugsContract = c.router({
  resolveGoSlug: {
    method: "GET",
    path: "/go/:slug",
    pathParams: z.object({ slug: slugParamSchema }),
    responses: {
      200: GoDisambiguationSchema,
      302: c.noBody(),
      400: errorSchema,
      401: errorSchema,
      403: errorSchema,
      404: errorSchema,
    },
    summary:
      "Resolve a slug within the active workspace (redirect or disambiguation)",
  },
  chooseGoSlug: {
    method: "POST",
    path: "/go/:slug/choose",
    pathParams: z.object({ slug: slugParamSchema }),
    body: ChooseSlugBodySchema,
    responses: {
      302: c.noBody(),
      400: errorSchema,
      401: errorSchema,
      403: errorSchema,
      404: errorSchema,
    },
    summary:
      "Choose a bookmark for an ambiguous slug; set remember: true to create or update a slug preference (management UI edit)",
  },
  listSlugPreferences: {
    method: "GET",
    path: "/go/preferences",
    responses: {
      200: SlugPreferenceListSchema,
      401: errorSchema,
      403: errorSchema,
    },
    summary:
      "List remembered slug-to-bookmark mappings for the current user with bookmark details and ambiguity status",
  },
  removeSlugPreference: {
    method: "DELETE",
    path: "/go/preferences/:id",
    pathParams: z.object({ id: z.string() }),
    body: c.noBody(),
    responses: {
      204: c.noBody(),
      401: errorSchema,
      403: errorSchema,
      404: errorSchema,
    },
    summary: "Remove a remembered slug preference",
  },
});
