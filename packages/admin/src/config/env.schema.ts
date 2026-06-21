import { z } from "zod";

/** Parses env-style booleans; `z.coerce.boolean()` treats the string `"false"` as true. */
function parseEnvBoolean(value: unknown, defaultValue: boolean): boolean {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") return true;
    if (normalized === "false" || normalized === "0") return false;
  }
  return Boolean(value);
}

const envBoolean = (defaultValue: boolean) =>
  z.preprocess((value) => parseEnvBoolean(value, defaultValue), z.boolean());

const adminEnvSchema = z
  .object({
    DATABASE_URL: z.string().min(1),
    NODE_ENV: z.enum(["development", "production", "test"]),
    SLUGBASE_EDITION: z.literal("cloud"),
    PORT: z.coerce.number().int().positive().default(3000),
    ADMIN_URL: z.string().url(),
    SMTP_HOST: z.string().min(1),
    SMTP_PORT: z.coerce.number().int().positive().default(587),
    SMTP_SECURE: envBoolean(false),
    SMTP_USER: z.string().min(1),
    SMTP_PASS: z.string().min(1),
    SMTP_FROM: z.string().min(1),
    ADMIN_SESSION_TTL_DAYS: z.coerce.number().int().positive().default(7),
    ADMIN_SNAPSHOT_CRON: z.string().min(1).default("0 2 * * *"),
    ADMIN_ALERT_SIGNUP_SPIKE_MULTIPLIER: z.coerce
      .number()
      .positive()
      .default(3),
    SENTRY_DSN: z.string().url().optional(),
    SENTRY_ENVIRONMENT: z.string().min(1).optional(),
    ADMIN_BOOTSTRAP_EMAIL: z.string().email().optional(),
    ADMIN_BOOTSTRAP_PASSWORD: z.string().min(12).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.NODE_ENV === "production") {
      if (!data.ADMIN_BOOTSTRAP_EMAIL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "ADMIN_BOOTSTRAP_EMAIL is required in production",
          path: ["ADMIN_BOOTSTRAP_EMAIL"],
        });
      }
      if (!data.ADMIN_BOOTSTRAP_PASSWORD) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "ADMIN_BOOTSTRAP_PASSWORD is required in production",
          path: ["ADMIN_BOOTSTRAP_PASSWORD"],
        });
      }
    }
  });

export type AdminEnv = z.infer<typeof adminEnvSchema>;

const ADMIN_ENV_KEYS = [
  "DATABASE_URL",
  "NODE_ENV",
  "SLUGBASE_EDITION",
  "PORT",
  "ADMIN_URL",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_SECURE",
  "SMTP_USER",
  "SMTP_PASS",
  "SMTP_FROM",
  "ADMIN_SESSION_TTL_DAYS",
  "ADMIN_SNAPSHOT_CRON",
  "ADMIN_ALERT_SIGNUP_SPIKE_MULTIPLIER",
  "SENTRY_DSN",
  "SENTRY_ENVIRONMENT",
  "ADMIN_BOOTSTRAP_EMAIL",
  "ADMIN_BOOTSTRAP_PASSWORD",
] as const satisfies readonly (keyof AdminEnv)[];

function pickAdminEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const picked: Record<string, string | undefined> = {};
  for (const key of ADMIN_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined) {
      picked[key] = value;
    }
  }
  return picked;
}

export function parseAdminEnv(
  env: Record<string, string | undefined> = process.env,
): AdminEnv {
  return adminEnvSchema.parse(pickAdminEnv(env));
}
