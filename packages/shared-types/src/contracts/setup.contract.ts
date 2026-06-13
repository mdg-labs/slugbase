import { initContract } from "@ts-rest/core";
import { z } from "zod";

const c = initContract();

export const SetupStatusResponseSchema = z
  .object({
    needsSetup: z.boolean(),
  })
  .strict();

export const SetupCompleteBodySchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(8),
    name: z.string().min(1),
    workspaceName: z.string().min(1),
    workspaceSlug: z.string().min(1),
  })
  .strict();

export const SetupCompleteResponseSchema = z
  .object({
    userId: z.string(),
  })
  .strict();

export type SetupStatusResponse = z.infer<typeof SetupStatusResponseSchema>;
export type SetupCompleteBody = z.infer<typeof SetupCompleteBodySchema>;
export type SetupCompleteResponse = z.infer<typeof SetupCompleteResponseSchema>;

export const setupContract = c.router({
  getStatus: {
    method: "GET",
    path: "/setup/status",
    responses: {
      200: SetupStatusResponseSchema,
    },
    summary: "Get instance first-run setup status",
  },
  complete: {
    method: "POST",
    path: "/setup/complete",
    body: SetupCompleteBodySchema,
    responses: {
      201: SetupCompleteResponseSchema,
      409: z.object({ message: z.string() }).strict(),
    },
    summary: "Complete first-run instance setup (creates the instance-admin account)",
  },
});
