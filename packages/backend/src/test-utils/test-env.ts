const testEnvKeys = [
  "NODE_ENV",
  "SESSION_SECRET",
  "ENCRYPTION_KEY",
  "DATABASE_URL",
  "APP_BASE_URL",
  "FRONTEND_ORIGIN",
  "STRIPE_SECRET_KEY",
] as const;

export const validTestEnv: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  SESSION_SECRET: "test-session-secret-with-32-chars-min",
  ENCRYPTION_KEY: "test-encryption-key-with-32-chars",
  DATABASE_URL: "sqlite://./test.db",
  APP_BASE_URL: "https://api.slugbase.test",
  FRONTEND_ORIGIN: "https://app.slugbase.test",
};

export function applyTestEnv(overrides: NodeJS.ProcessEnv = {}): void {
  Object.assign(process.env, validTestEnv, overrides);
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
