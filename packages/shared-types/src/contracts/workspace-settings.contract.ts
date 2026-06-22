/**
 * Workspace settings HTTP contracts (spec §11.5, §11.2, §5.6, §15).
 *
 * Covers operator-level settings managed by workspace admins:
 *   - AI provider configuration (self-hosted)
 *   - OIDC identity provider admin CRUD
 *
 * SMTP transport is operator-managed via deployment env vars (spec §15) — no
 * workspace mail settings HTTP surface in v1.
 */

import { initContract } from "@ts-rest/core";
import { z } from "zod";

const c = initContract();

// ─── Mail settings (spec §11.5, §11.11) ─────────────────────────────────────

export const MailSettingsSchema = z
  .object({
    host: z.string().nullable(),
    port: z.number().int().nullable(),
    secure: z.boolean(),
    user: z.string().nullable(),
    /** True when a password is stored - never return the encrypted value */
    hasPassword: z.boolean(),
    from: z.string().nullable(),
  })
  .strict();

export const UpdateMailSettingsBodySchema = z
  .object({
    host: z.string().min(1).max(253).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    secure: z.boolean().optional(),
    user: z.string().max(255).optional().nullable(),
    /** Supply to set or replace the password. Omit to leave unchanged. */
    password: z.string().max(512).optional().nullable(),
    from: z.string().email().max(255).optional(),
  })
  .strict();

export const SendTestMailBodySchema = z
  .object({
    to: z.string().email().max(255),
  })
  .strict();

export type MailSettings = z.infer<typeof MailSettingsSchema>;
export type UpdateMailSettingsBody = z.infer<typeof UpdateMailSettingsBodySchema>;
export type SendTestMailBody = z.infer<typeof SendTestMailBodySchema>;

// ─── AI settings (spec §11.2, §15) ───────────────────────────────────────────

export const AiProviderSchema = z.enum(["openai"]);

export const AiSettingsSchema = z
  .object({
    provider: AiProviderSchema.nullable(),
    /** True when OPENAI_API_KEY is set in deployment env — never return the key */
    hasApiKey: z.boolean(),
    /** Model from OPENAI_MODEL env — read-only, not persisted per workspace */
    model: z.string().nullable(),
    /** Per-workspace enable toggle (workspace-scoped storage) */
    enabled: z.boolean(),
  })
  .strict();

export const UpdateAiSettingsBodySchema = z
  .object({
    enabled: z.boolean().optional(),
  })
  .strict();

export type AiProvider = z.infer<typeof AiProviderSchema>;
export type AiSettings = z.infer<typeof AiSettingsSchema>;
export type UpdateAiSettingsBody = z.infer<typeof UpdateAiSettingsBodySchema>;

// ─── OIDC provider admin (spec §5.6, §11.11) ─────────────────────────────────

export const OidcProviderSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    issuerUrl: z.string(),
    clientId: z.string(),
    /** True when a client secret is stored - never return the encrypted value */
    hasClientSecret: z.boolean(),
    scopes: z.string(),
    enabled: z.boolean(),
    createdAt: z.string().datetime(),
  })
  .strict();

export const CreateOidcProviderBodySchema = z
  .object({
    name: z.string().min(1).max(100),
    issuerUrl: z.string().url().max(512),
    clientId: z.string().min(1).max(255),
    clientSecret: z.string().min(1).max(512),
    scopes: z.string().max(255).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export const UpdateOidcProviderBodySchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    issuerUrl: z.string().url().max(512).optional(),
    clientId: z.string().min(1).max(255).optional(),
    /** Supply to replace the client secret. Omit to leave unchanged. */
    clientSecret: z.string().min(1).max(512).optional(),
    scopes: z.string().max(255).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export type OidcProvider = z.infer<typeof OidcProviderSchema>;
export type CreateOidcProviderBody = z.infer<typeof CreateOidcProviderBodySchema>;
export type UpdateOidcProviderBody = z.infer<typeof UpdateOidcProviderBodySchema>;

// ─── HTTP contracts ───────────────────────────────────────────────────────────

const errorSchema = z.object({ message: z.string() }).strict();

export const workspaceSettingsContract = c.router({
  // AI settings
  getAiSettings: {
    method: "GET",
    path: "/workspace/settings/ai",
    responses: {
      200: AiSettingsSchema,
      403: errorSchema,
    },
    summary: "Get workspace AI settings (ADMIN+, spec §11.2)",
  },
  updateAiSettings: {
    method: "PATCH",
    path: "/workspace/settings/ai",
    body: UpdateAiSettingsBodySchema,
    responses: {
      200: AiSettingsSchema,
      400: errorSchema,
      403: errorSchema,
    },
    summary: "Update workspace AI settings (ADMIN+, spec §11.2)",
  },
  // OIDC provider admin
  listOidcProviders: {
    method: "GET",
    path: "/workspace/settings/oidc/providers",
    responses: {
      200: z.array(OidcProviderSchema),
      403: errorSchema,
    },
    summary: "List OIDC providers (ADMIN+, spec §5.6)",
  },
  createOidcProvider: {
    method: "POST",
    path: "/workspace/settings/oidc/providers",
    body: CreateOidcProviderBodySchema,
    responses: {
      201: OidcProviderSchema,
      400: errorSchema,
      403: errorSchema,
      409: errorSchema,
    },
    summary: "Create an OIDC provider (ADMIN+, spec §5.6, §11.11)",
  },
  updateOidcProvider: {
    method: "PATCH",
    path: "/workspace/settings/oidc/providers/:providerId",
    pathParams: z.object({ providerId: z.string() }),
    body: UpdateOidcProviderBodySchema,
    responses: {
      200: OidcProviderSchema,
      400: errorSchema,
      403: errorSchema,
      404: errorSchema,
      409: errorSchema,
    },
    summary: "Update an OIDC provider (ADMIN+, spec §5.6)",
  },
  deleteOidcProvider: {
    method: "DELETE",
    path: "/workspace/settings/oidc/providers/:providerId",
    pathParams: z.object({ providerId: z.string() }),
    body: c.noBody(),
    responses: {
      204: c.noBody(),
      403: errorSchema,
      404: errorSchema,
    },
    summary: "Delete an OIDC provider (ADMIN+, spec §5.6)",
  },
});
