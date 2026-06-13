import { initContract } from "@ts-rest/core";
import { z } from "zod";

const c = initContract();

export const HealthResponseSchema = z
  .object({
    status: z.literal("ok"),
  })
  .strict();

export const VersionResponseSchema = z
  .object({
    version: z.string(),
  })
  .strict();

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
export type VersionResponse = z.infer<typeof VersionResponseSchema>;

export const healthContract = c.router({
  getHealth: {
    method: "GET",
    path: "/health",
    responses: {
      200: HealthResponseSchema,
    },
    summary: "Health check",
  },
  getVersion: {
    method: "GET",
    path: "/version",
    responses: {
      200: VersionResponseSchema,
    },
    summary: "Application version",
  },
});
