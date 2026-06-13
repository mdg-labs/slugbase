import { initContract } from "@ts-rest/core";
import { z } from "zod";

const c = initContract();

const ApiTokenSummarySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    lastUsedAt: z.coerce.date().nullable(),
    createdAt: z.coerce.date(),
    expiresAt: z.coerce.date().nullable(),
  })
  .strict();

export const CreateApiTokenBodySchema = z
  .object({ name: z.string().min(1).max(100) })
  .strict();

export const CreateApiTokenResponseSchema = z
  .object({
    token: ApiTokenSummarySchema,
    plaintext: z.string(),
  })
  .strict();

export const ListApiTokensResponseSchema = z
  .object({ tokens: z.array(ApiTokenSummarySchema) })
  .strict();

export const DeleteApiTokenResponseSchema = z
  .object({ ok: z.literal(true) })
  .strict();

export type ApiTokenSummary = z.infer<typeof ApiTokenSummarySchema>;
export type CreateApiTokenBody = z.infer<typeof CreateApiTokenBodySchema>;
export type CreateApiTokenResponse = z.infer<typeof CreateApiTokenResponseSchema>;
export type ListApiTokensResponse = z.infer<typeof ListApiTokensResponseSchema>;
export type DeleteApiTokenResponse = z.infer<typeof DeleteApiTokenResponseSchema>;

const unauthorizedSchema = z.object({ message: z.string() }).strict();

export const apiTokenContract = c.router({
  createToken: {
    method: "POST",
    path: "/auth/api-tokens",
    body: CreateApiTokenBodySchema,
    responses: {
      201: CreateApiTokenResponseSchema,
      401: unauthorizedSchema,
      409: z.object({ message: z.string() }).strict(),
      422: z.object({ message: z.string() }).strict(),
    },
    summary: "Create a named API token - returns plaintext once",
  },
  listTokens: {
    method: "GET",
    path: "/auth/api-tokens",
    responses: {
      200: ListApiTokensResponseSchema,
      401: unauthorizedSchema,
    },
    summary: "List API tokens for the current user (no hashes returned)",
  },
  deleteToken: {
    method: "DELETE",
    path: "/auth/api-tokens/:id",
    body: c.noBody(),
    responses: {
      200: DeleteApiTokenResponseSchema,
      401: unauthorizedSchema,
      404: z.object({ message: z.string() }).strict(),
    },
    summary: "Delete an API token by ID",
  },
});
