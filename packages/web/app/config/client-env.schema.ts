import { z } from "zod";

/** Optional public URL from build-time env — unset or empty is valid (self-host). */
const optionalPublicUrl = z.preprocess((value) => {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value === "string" && value.trim() === "") {
    return undefined;
  }
  return value;
}, z.string().url().optional());

export const clientEnvSchema = z
  .object({
    VITE_MARKETING_ORIGIN: optionalPublicUrl,
  })
  .strict();

export type ClientEnvConfig = z.infer<typeof clientEnvSchema>;

export function validateClientEnvConfig(
  raw: Record<string, unknown>,
): ClientEnvConfig {
  return clientEnvSchema.parse(raw);
}
