import { z } from "zod";

import { ADMIN_ROLES } from "./admin-roles.js";

export const loginBodySchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(1),
  })
  .strict();

export const createInviteBodySchema = z
  .object({
    email: z.string().email(),
    role: z.enum(ADMIN_ROLES),
  })
  .strict();

export const acceptInviteBodySchema = z
  .object({
    token: z.string().min(1),
    password: z.string().min(12),
  })
  .strict();

export interface AdminMeResponse {
  id: string;
  email: string;
  role: string;
}

export interface AdminLoginResponse {
  user: AdminMeResponse;
}
