import { initContract } from "@ts-rest/core";
import { z } from "zod";

const c = initContract();

export const LoginBodySchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(1),
  })
  .strict();

export const LoginResponseSchema = z
  .object({
    userId: z.string(),
  })
  .strict();

export const LogoutResponseSchema = z
  .object({
    ok: z.literal(true),
  })
  .strict();

export const MeResponseSchema = z
  .object({
    id: z.string(),
    email: z.string(),
    name: z.string(),
    mfaState: z.enum(["not_enrolled", "pending", "enrolled"]),
    emailVerified: z.boolean(),
  })
  .strict();

export const ForgotPasswordBodySchema = z
  .object({
    email: z.string().email(),
  })
  .strict();

export const ForgotPasswordResponseSchema = z
  .object({
    ok: z.literal(true),
  })
  .strict();

export const ResetPasswordBodySchema = z
  .object({
    token: z.string().min(1),
    newPassword: z.string().min(12),
  })
  .strict();

export const ResetPasswordResponseSchema = z
  .object({
    ok: z.literal(true),
  })
  .strict();

export type LoginBody = z.infer<typeof LoginBodySchema>;
export type LoginResponse = z.infer<typeof LoginResponseSchema>;
export type LogoutResponse = z.infer<typeof LogoutResponseSchema>;
export type MeResponse = z.infer<typeof MeResponseSchema>;
export type ForgotPasswordBody = z.infer<typeof ForgotPasswordBodySchema>;
export type ForgotPasswordResponse = z.infer<typeof ForgotPasswordResponseSchema>;
export type ResetPasswordBody = z.infer<typeof ResetPasswordBodySchema>;
export type ResetPasswordResponse = z.infer<typeof ResetPasswordResponseSchema>;

export const authContract = c.router({
  login: {
    method: "POST",
    path: "/auth/login",
    body: LoginBodySchema,
    responses: {
      200: LoginResponseSchema,
      401: z.object({ message: z.string() }).strict(),
    },
    summary: "Login with email and password",
  },
  logout: {
    method: "POST",
    path: "/auth/logout",
    body: c.noBody(),
    responses: {
      200: LogoutResponseSchema,
    },
    summary: "Logout and revoke the current session",
  },
  me: {
    method: "GET",
    path: "/auth/me",
    responses: {
      200: MeResponseSchema,
      401: z.object({ message: z.string() }).strict(),
    },
    summary: "Get the current authenticated user",
  },
  forgotPassword: {
    method: "POST",
    path: "/auth/forgot-password",
    body: ForgotPasswordBodySchema,
    responses: {
      200: ForgotPasswordResponseSchema,
    },
    summary:
      "Request a password reset email. Non-enumerating: always returns 200 regardless of whether the email is registered.",
  },
  resetPassword: {
    method: "POST",
    path: "/auth/reset-password",
    body: ResetPasswordBodySchema,
    responses: {
      200: ResetPasswordResponseSchema,
      422: z.object({ message: z.string() }).strict(),
    },
    summary:
      "Complete a password reset using a token from the reset email. Invalidates all existing sessions on success.",
  },
});
