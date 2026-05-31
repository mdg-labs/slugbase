import { initContract } from "@ts-rest/core";
import { z } from "zod";

const c = initContract();

export const RegisterBodySchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(8),
    name: z.string().min(1),
    workspaceName: z.string().min(1).optional(),
    workspaceSlug: z.string().min(1).optional(),
  })
  .strict();

export const RegisterResponseSchema = z
  .object({
    userId: z.string(),
  })
  .strict();

export type RegisterBody = z.infer<typeof RegisterBodySchema>;
export type RegisterResponse = z.infer<typeof RegisterResponseSchema>;

export const registrationContract = c.router({
  register: {
    method: "POST",
    path: "/auth/register",
    body: RegisterBodySchema,
    responses: {
      201: RegisterResponseSchema,
      403: z.object({ message: z.string() }).strict(),
      409: z.object({ message: z.string() }).strict(),
    },
    summary: "Register a new user account (requires PUBLIC_REGISTRATION=true)",
  },
});
