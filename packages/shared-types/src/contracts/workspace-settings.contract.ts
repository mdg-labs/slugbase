/**
 * Workspace settings HTTP contracts (spec §11.2, §15).
 *
 * Covers operator-level settings managed by workspace admins:
 *   - AI provider configuration (self-hosted)
 *
 * SMTP transport is operator-managed via deployment env vars (spec §11.1, §15) —
 * no workspace mail settings HTTP surface in v1.
 *
 * OIDC identity providers are operator-managed via deployment env vars (spec §11.3,
 * §15) — no workspace OIDC admin HTTP surface in v1. Public login provider list
 * lives on GET /auth/oidc/providers (auth.contract.ts).
 */

import { initContract } from "@ts-rest/core";
import { z } from "zod";

const c = initContract();

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

// ─── Mail transport status (spec §11.1, §10.1) ──────────────────────────────

export const MailTransportStatusSchema = z
  .object({
    /** True when the runtime mail transport is configured and operational */
    mailTransportAvailable: z.boolean(),
  })
  .strict();

export type MailTransportStatus = z.infer<typeof MailTransportStatusSchema>;

// ─── HTTP contracts ───────────────────────────────────────────────────────────

const errorSchema = z.object({ message: z.string() }).strict();

export const workspaceSettingsContract = c.router({
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
  getMailTransportStatus: {
    method: "GET",
    path: "/workspace/settings/mail/status",
    responses: {
      200: MailTransportStatusSchema,
      403: errorSchema,
    },
    summary: "Get mail transport availability for Members settings (ADMIN+, spec §11.1)",
  },
});
