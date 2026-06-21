import {
  EditionPresetConflictError,
  resolveEnvWithEdition,
  SLUGBASE_EDITION,
  SlugbaseEditionParseError,
  type SlugbaseEdition,
} from "@slugbase/shared-types";

import { parseEnvConfig, type AppConfig } from "./env.schema.js";

const DEV_DEFAULT_EDITION = SLUGBASE_EDITION.CE;

function isProductionNodeEnv(env: NodeJS.ProcessEnv): boolean {
  return (env.NODE_ENV ?? "development").trim().toLowerCase() === "production";
}

function resolveEditionRaw(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.SLUGBASE_EDITION;
  if (raw !== undefined && raw.trim() !== "") {
    return raw;
  }
  if (isProductionNodeEnv(env)) {
    return undefined;
  }
  return DEV_DEFAULT_EDITION;
}

function toProcessEnv(resolved: Record<string, string>): NodeJS.ProcessEnv {
  return resolved;
}

function formatStartupError(prefix: string, error: Error): Error {
  return new Error(`${prefix}: ${error.message}`);
}

/**
 * Applies `SLUGBASE_EDITION` presets, validates env, and returns `AppConfig`.
 * Canonical bootstrap entry for `main.ts` and `ConfigModule`.
 */
export function loadAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const editionRaw = resolveEditionRaw(env);

  let resolved;
  try {
    resolved = resolveEnvWithEdition(env, { editionRaw });
  } catch (error) {
    if (error instanceof SlugbaseEditionParseError) {
      const prefix = isProductionNodeEnv(env)
        ? "Production startup refused"
        : "Invalid configuration";
      throw formatStartupError(prefix, error);
    }
    if (error instanceof EditionPresetConflictError) {
      throw formatStartupError("Production startup refused", error);
    }
    throw error;
  }

  const config = parseEnvConfig(toProcessEnv(resolved.env));
  return { ...config, edition: resolved.edition };
}

export type { SlugbaseEdition };
