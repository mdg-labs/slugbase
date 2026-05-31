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
  })
  .strict();

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
