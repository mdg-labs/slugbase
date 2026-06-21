import {
  EditionPresetConflictError,
  resolveEnvWithEdition,
  SLUGBASE_EDITION,
  SlugbaseEditionParseError,
  type EditionPresetKey,
} from "@slugbase/shared-types";

/** Vite build-time flags derived from `SLUGBASE_EDITION` (spec §15). */
export const VITE_EDITION_ENV_KEYS = [
  "VITE_BILLING_ENABLED",
  "VITE_MAIL_ADMIN_UI",
  "VITE_OIDC_ADMIN_UI",
  "VITE_AI_BYO_CREDENTIAL",
] as const satisfies readonly EditionPresetKey[];

export type ViteEditionEnvKey = (typeof VITE_EDITION_ENV_KEYS)[number];

const DEV_DEFAULT_EDITION = SLUGBASE_EDITION.CE;

function isProductionNodeEnv(env: NodeJS.ProcessEnv): boolean {
  return (env.NODE_ENV ?? "development").trim().toLowerCase() === "production";
}

function resolveEditionRaw(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.SLUGBASE_EDITION;
  if (raw !== undefined && raw.trim() !== "") {
    return raw;
  }
  return DEV_DEFAULT_EDITION;
}

function toRawEnvRecord(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const raw: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    raw[key] = value;
  }
  return raw;
}

function formatStartupError(prefix: string, error: Error): Error {
  return new Error(`${prefix}: ${error.message}`);
}

/**
 * Applies `SLUGBASE_EDITION` presets to `process.env` for Vite build-time flags.
 * Mirrors backend `loadAppConfig` edition resolution (spec §15).
 */
export function applyViteEditionEnv(env: NodeJS.ProcessEnv = process.env): void {
  const editionRaw = resolveEditionRaw(env);

  let resolved;
  try {
    resolved = resolveEnvWithEdition(toRawEnvRecord(env), { editionRaw });
  } catch (error) {
    if (error instanceof SlugbaseEditionParseError) {
      const prefix = isProductionNodeEnv(env)
        ? "Production web build refused"
        : "Invalid configuration";
      throw formatStartupError(prefix, error);
    }
    if (error instanceof EditionPresetConflictError) {
      throw formatStartupError("Production web build refused", error);
    }
    throw error;
  }

  env.SLUGBASE_EDITION = resolved.edition;
  for (const key of VITE_EDITION_ENV_KEYS) {
    env[key] = resolved.env[key];
  }
}
