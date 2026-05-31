import { initContract } from "@ts-rest/core";
import { z } from "zod";

const c = initContract();

export const MfaEnrolStartResponseSchema = z
  .object({
    otpAuthUri: z.string(),
    textSecret: z.string(),
    qrDataUri: z.string(),
  })
  .strict();

export const MfaEnrolConfirmBodySchema = z
  .object({ totpCode: z.string().min(1) })
  .strict();

export const MfaEnrolConfirmResponseSchema = z
  .object({ backupCodes: z.array(z.string()) })
  .strict();

export const MfaChallengeBodySchema = z
  .object({ code: z.string().min(1) })
  .strict();

export const MfaChallengeResponseSchema = z
  .object({ userId: z.string() })
  .strict();

export const MfaDisableBodySchema = z
  .object({ totpCode: z.string().min(1) })
  .strict();

export const MfaDisableResponseSchema = z
  .object({ ok: z.literal(true) })
  .strict();

export const MfaRegenerateBodySchema = z
  .object({ totpCode: z.string().min(1) })
  .strict();

export const MfaRegenerateResponseSchema = z
  .object({ backupCodes: z.array(z.string()) })
  .strict();

const unauthorizedSchema = z.object({ message: z.string() }).strict();

export type MfaEnrolStartResponse = z.infer<typeof MfaEnrolStartResponseSchema>;
export type MfaEnrolConfirmBody = z.infer<typeof MfaEnrolConfirmBodySchema>;
export type MfaEnrolConfirmResponse = z.infer<typeof MfaEnrolConfirmResponseSchema>;
export type MfaChallengeBody = z.infer<typeof MfaChallengeBodySchema>;
export type MfaChallengeResponse = z.infer<typeof MfaChallengeResponseSchema>;
export type MfaDisableBody = z.infer<typeof MfaDisableBodySchema>;
export type MfaDisableResponse = z.infer<typeof MfaDisableResponseSchema>;
export type MfaRegenerateBody = z.infer<typeof MfaRegenerateBodySchema>;
export type MfaRegenerateResponse = z.infer<typeof MfaRegenerateResponseSchema>;

export const mfaContract = c.router({
  enrolStart: {
    method: "POST",
    path: "/auth/mfa/enrol/start",
    body: c.noBody(),
    responses: {
      200: MfaEnrolStartResponseSchema,
      401: unauthorizedSchema,
    },
    summary: "Start TOTP MFA enrollment — returns QR code and text secret",
  },
  enrolConfirm: {
    method: "POST",
    path: "/auth/mfa/enrol/confirm",
    body: MfaEnrolConfirmBodySchema,
    responses: {
      200: MfaEnrolConfirmResponseSchema,
      401: unauthorizedSchema,
    },
    summary: "Confirm TOTP MFA enrollment — returns 10 single-use backup codes (shown once)",
  },
  challenge: {
    method: "POST",
    path: "/auth/mfa/challenge",
    body: MfaChallengeBodySchema,
    responses: {
      200: MfaChallengeResponseSchema,
      401: unauthorizedSchema,
    },
    summary: "Complete MFA challenge during login using TOTP or backup code",
  },
  disable: {
    method: "POST",
    path: "/auth/mfa/disable",
    body: MfaDisableBodySchema,
    responses: {
      200: MfaDisableResponseSchema,
      401: unauthorizedSchema,
    },
    summary: "Disable MFA (requires current TOTP verification)",
  },
  regenerateBackupCodes: {
    method: "POST",
    path: "/auth/mfa/backup-codes/regenerate",
    body: MfaRegenerateBodySchema,
    responses: {
      200: MfaRegenerateResponseSchema,
      401: unauthorizedSchema,
    },
    summary: "Regenerate backup codes (requires current TOTP verification, shown once)",
  },
});
