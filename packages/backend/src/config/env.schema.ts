import { z } from "zod";

const requiredSecretsSchema = z
  .object({
    SESSION_SECRET: z.string().min(32),
    ENCRYPTION_KEY: z.string().min(32),
    DATABASE_URL: z.string().min(1),
    APP_BASE_URL: z.string().url(),
    FRONTEND_ORIGIN: z.string().url(),
  })
  .strict();

const optionalFlagsSchema = z
  .object({
    PUBLIC_REGISTRATION: z.coerce.boolean().default(false),
    EMAIL_VERIFICATION_REQUIRED: z.coerce.boolean().default(false),
    PORT: z.coerce.number().int().positive().default(3000),
    SERVE_WEB_CLIENT: z.coerce.boolean().default(false),
    WEB_CLIENT_SERVER_BUILD: z.string().min(1).optional(),
    // SMTP transport (spec §11.1, §15) — optional; no-op mail used when SMTP_HOST is absent
    SMTP_HOST: z.string().min(1).optional(),
    SMTP_PORT: z.coerce.number().int().positive().default(587),
    SMTP_SECURE: z.coerce.boolean().default(false),
    SMTP_USER: z.string().min(1).optional(),
    SMTP_PASS: z.string().min(1).optional(),
    SMTP_FROM: z.string().min(1).optional(),
    // OpenAI AI suggestions (spec §11.2, §15) — optional; no-op AI used when absent
    OPENAI_API_KEY: z.string().min(1).optional(),
    OPENAI_MODEL: z.string().min(1).default("gpt-4o-mini"),
    // Session TTL (spec §5.3, def §3) — sliding window; default 30 days
    SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
    // MFA TOTP issuer label shown in authenticator apps (spec §5.7)
    MFA_TOTP_ISSUER: z.string().min(1).default("SlugBase"),
    // Rate limiting (spec §18, def §4) — IP-based for login/register/MFA; user-based for token creation
    RATE_LIMIT_LOGIN_MAX: z.coerce.number().int().positive().default(10),
    RATE_LIMIT_LOGIN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    RATE_LIMIT_TOKEN_CREATION_MAX: z.coerce.number().int().positive().default(20),
    RATE_LIMIT_TOKEN_CREATION_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  })
  .strict()
  .superRefine((flags, ctx) => {
    if (flags.SERVE_WEB_CLIENT && !flags.WEB_CLIENT_SERVER_BUILD) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "WEB_CLIENT_SERVER_BUILD is required when SERVE_WEB_CLIENT is enabled",
        path: ["WEB_CLIENT_SERVER_BUILD"],
      });
    }
  });

export type RequiredSecrets = z.infer<typeof requiredSecretsSchema>;
export type OptionalFlags = z.infer<typeof optionalFlagsSchema>;

export type AppConfig = RequiredSecrets &
  OptionalFlags & {
    nodeEnv: NodeEnv;
    isProduction: boolean;
  };

export type NodeEnv = "development" | "test" | "production";

const nodeEnvSchema = z.enum(["development", "test", "production"]);

function parseNodeEnv(value: string | undefined): NodeEnv {
  const parsed = nodeEnvSchema.safeParse(value ?? "development");
  if (!parsed.success) {
    return "development";
  }
  return parsed.data;
}

function readSecretsInput(env: NodeJS.ProcessEnv) {
  return {
    SESSION_SECRET: env.SESSION_SECRET,
    ENCRYPTION_KEY: env.ENCRYPTION_KEY,
    DATABASE_URL: env.DATABASE_URL,
    APP_BASE_URL: env.APP_BASE_URL,
    FRONTEND_ORIGIN: env.FRONTEND_ORIGIN,
  };
}

function readFlagsInput(env: NodeJS.ProcessEnv) {
  return {
    PUBLIC_REGISTRATION: env.PUBLIC_REGISTRATION,
    EMAIL_VERIFICATION_REQUIRED: env.EMAIL_VERIFICATION_REQUIRED,
    PORT: env.PORT,
    SERVE_WEB_CLIENT: env.SERVE_WEB_CLIENT,
    WEB_CLIENT_SERVER_BUILD: env.WEB_CLIENT_SERVER_BUILD,
    SMTP_HOST: env.SMTP_HOST,
    SMTP_PORT: env.SMTP_PORT,
    SMTP_SECURE: env.SMTP_SECURE,
    SMTP_USER: env.SMTP_USER,
    SMTP_PASS: env.SMTP_PASS,
    SMTP_FROM: env.SMTP_FROM,
    OPENAI_API_KEY: env.OPENAI_API_KEY,
    OPENAI_MODEL: env.OPENAI_MODEL,
    SESSION_TTL_DAYS: env.SESSION_TTL_DAYS,
    MFA_TOTP_ISSUER: env.MFA_TOTP_ISSUER,
    RATE_LIMIT_LOGIN_MAX: env.RATE_LIMIT_LOGIN_MAX,
    RATE_LIMIT_LOGIN_TTL_SECONDS: env.RATE_LIMIT_LOGIN_TTL_SECONDS,
    RATE_LIMIT_TOKEN_CREATION_MAX: env.RATE_LIMIT_TOKEN_CREATION_MAX,
    RATE_LIMIT_TOKEN_CREATION_TTL_SECONDS: env.RATE_LIMIT_TOKEN_CREATION_TTL_SECONDS,
  };
}

export function validateEnvConfig(
  env: NodeJS.ProcessEnv = process.env,
): AppConfig {
  const nodeEnv = parseNodeEnv(env.NODE_ENV);
  const isProduction = nodeEnv === "production";
  const secretsInput = readSecretsInput(env);
  const flagsInput = readFlagsInput(env);

  if (isProduction) {
    const secretsResult = requiredSecretsSchema.safeParse(secretsInput);
    if (!secretsResult.success) {
      throw new Error(
        `Production startup refused: missing or invalid required secrets — ${secretsResult.error.message}`,
      );
    }

    const flagsResult = optionalFlagsSchema.safeParse(flagsInput);
    if (!flagsResult.success) {
      throw new Error(
        `Production startup refused: invalid deployment flags — ${flagsResult.error.message}`,
      );
    }

    return {
      ...secretsResult.data,
      ...flagsResult.data,
      nodeEnv,
      isProduction,
    };
  }

  const secretsResult = requiredSecretsSchema.safeParse(secretsInput);
  if (!secretsResult.success) {
    throw new Error(
      `Invalid configuration: missing or invalid required secrets — ${secretsResult.error.message}`,
    );
  }

  const flagsResult = optionalFlagsSchema.safeParse(flagsInput);
  if (!flagsResult.success) {
    throw new Error(
      `Invalid configuration: invalid deployment flags — ${flagsResult.error.message}`,
    );
  }

  return {
    ...secretsResult.data,
    ...flagsResult.data,
    nodeEnv,
    isProduction,
  };
}
