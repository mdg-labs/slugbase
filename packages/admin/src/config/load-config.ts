import { parseAdminEnv, type AdminEnv } from "./env.schema.js";

let cachedConfig: AdminEnv | undefined;

export function loadAdminConfig(
  env: Record<string, string | undefined> = process.env,
): AdminEnv {
  if (cachedConfig === undefined) {
    cachedConfig = parseAdminEnv(env);
  }
  return cachedConfig;
}

export function resetAdminConfigCache(): void {
  cachedConfig = undefined;
}
