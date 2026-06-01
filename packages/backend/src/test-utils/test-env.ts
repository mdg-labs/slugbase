const testEnvKeys = [
  "NODE_ENV",
  "SESSION_SECRET",
  "ENCRYPTION_KEY",
  "APP_BASE_URL",
  "FRONTEND_ORIGIN",
  "STRIPE_SECRET_KEY",
  "OPENAI_API_KEY",
  "OPENAPI_INTERACTIVE_DOCS",
] as const;

export const validTestEnv: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  SESSION_SECRET: "test-session-secret-with-32-chars-min",
  ENCRYPTION_KEY: "test-encryption-key-with-32-chars",
  DATABASE_URL:
    process.env.DATABASE_URL ??
    "postgresql://slugbase:slugbase@localhost:5432/slugbase_test",
  APP_BASE_URL: "https://api.slugbase.test",
  FRONTEND_ORIGIN: "https://app.slugbase.test",
};

export function applyTestEnv(overrides: NodeJS.ProcessEnv = {}): void {
  const env: NodeJS.ProcessEnv = { ...validTestEnv, ...overrides };
  if (process.env.DATABASE_URL && overrides.DATABASE_URL === undefined) {
    env.DATABASE_URL = process.env.DATABASE_URL;
  }
  Object.assign(process.env, env);
}

export function clearTestEnv(): void {
  for (const key of testEnvKeys) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- test teardown
    delete process.env[key];
  }
}

export function productionEnvWithoutSessionSecret(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    ENCRYPTION_KEY: validTestEnv.ENCRYPTION_KEY,
    DATABASE_URL: validTestEnv.DATABASE_URL,
    APP_BASE_URL: validTestEnv.APP_BASE_URL,
    FRONTEND_ORIGIN: validTestEnv.FRONTEND_ORIGIN,
  };
}
