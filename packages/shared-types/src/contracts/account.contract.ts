import { initContract } from "@ts-rest/core";
import { z } from "zod";

const c = initContract();

const mfaStateSchema = z.enum(["not_enrolled", "pending", "enrolled"]);
const languageSchema = z.enum(["en", "de"]);
const themeSchema = z.enum(["light", "dark", "auto"]);

export const ALLOWED_ACCENT_COLORS = [
  "#7782f7",
  "#6366f1",
  "#45c98a",
  "#e6b24e",
  "#f0686b",
] as const;

export type AllowedAccentColor = (typeof ALLOWED_ACCENT_COLORS)[number];

const accentColorSchema = z
  .enum(ALLOWED_ACCENT_COLORS)
  .nullable();

export const AccountSettingsResponseSchema = z
  .object({
    id: z.string(),
    email: z.string(),
    name: z.string(),
    emailVerified: z.boolean(),
    mfaState: mfaStateSchema,
    remainingBackupCodes: z.number().int().nullable(),
    hasPassword: z.boolean(),
    language: languageSchema,
    theme: themeSchema,
    accentColor: accentColorSchema,
    aiOptOut: z.boolean(),
  })
  .strict();

export const UpdateAccountProfileBodySchema = z
  .object({
    name: z.string().min(1).max(120),
  })
  .strict();

export const UpdateAccountProfileResponseSchema = AccountSettingsResponseSchema;

export const UpdateAccountPasswordBodySchema = z
  .object({
    currentPassword: z.string().min(1).optional(),
    newPassword: z.string().min(12),
  })
  .strict();

export const UpdateAccountPasswordResponseSchema = z
  .object({ ok: z.literal(true) })
  .strict();

export const UpdateAccountPreferencesBodySchema = z
  .object({
    language: languageSchema.optional(),
    theme: themeSchema.optional(),
    accentColor: accentColorSchema.optional(),
    aiOptOut: z.boolean().optional(),
  })
  .strict();

export const UpdateAccountPreferencesResponseSchema = AccountSettingsResponseSchema;

export type AccountSettingsResponse = z.infer<typeof AccountSettingsResponseSchema>;
export type UpdateAccountProfileBody = z.infer<typeof UpdateAccountProfileBodySchema>;
export type UpdateAccountPasswordBody = z.infer<typeof UpdateAccountPasswordBodySchema>;
export type UpdateAccountPreferencesBody = z.infer<typeof UpdateAccountPreferencesBodySchema>;

const unauthorizedSchema = z.object({ message: z.string() }).strict();

export const accountContract = c.router({
  getAccount: {
    method: "GET",
    path: "/auth/account",
    responses: {
      200: AccountSettingsResponseSchema,
      401: unauthorizedSchema,
    },
    summary: "Get account settings for the current user",
  },
  updateProfile: {
    method: "PATCH",
    path: "/auth/account/profile",
    body: UpdateAccountProfileBodySchema,
    responses: {
      200: UpdateAccountProfileResponseSchema,
      401: unauthorizedSchema,
    },
    summary: "Update display name",
  },
  updatePassword: {
    method: "PATCH",
    path: "/auth/account/password",
    body: UpdateAccountPasswordBodySchema,
    responses: {
      200: UpdateAccountPasswordResponseSchema,
      401: unauthorizedSchema,
      422: z.object({ message: z.string() }).strict(),
    },
    summary: "Change or set account password",
  },
  updatePreferences: {
    method: "PATCH",
    path: "/auth/account/preferences",
    body: UpdateAccountPreferencesBodySchema,
    responses: {
      200: UpdateAccountPreferencesResponseSchema,
      401: unauthorizedSchema,
    },
    summary: "Update language, theme, accent color, and AI opt-out",
  },
});
