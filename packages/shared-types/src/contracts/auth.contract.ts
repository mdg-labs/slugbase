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

export type LoginBody = z.infer<typeof LoginBodySchema>;
export type LoginResponse = z.infer<typeof LoginResponseSchema>;
export type LogoutResponse = z.infer<typeof LogoutResponseSchema>;
export type MeResponse = z.infer<typeof MeResponseSchema>;

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
});
