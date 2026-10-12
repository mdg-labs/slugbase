import type { z } from "zod";
import type { ConfigIssue, EnvSchema, RefineContext } from "./fragment.js";
import { declaredKeys, envSchemas, type ConfigByProcess, type ProcessType } from "./schemas.js";

export type EnvironmentVariables = Readonly<Record<string, string | undefined>>;

/**
 * The environment is invalid. The message and `issues` name keys and what is
 * wrong with them; no value of the environment is in either (doc 01 section 11, T7).
 */
export class ConfigError extends Error {
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    super(`Invalid configuration: ${issues.map((issue) => `${issue.key} ${issue.message}`).join("; ")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

export interface LoadedConfig<Config> {
  readonly config: Config;
  /** Messages for the startup log. They name keys only. */
  readonly warnings: readonly string[];
}

export interface LoadOptions {
  /** Keys of modules beyond the process schema that are not unknown (a Cloud module's fragment). */
  readonly extraKeys?: readonly string[];
}

const SLUGBASE_PREFIX = "SLUGBASE_";

function describe(issue: z.core.$ZodIssue, env: EnvironmentVariables): ConfigIssue {
  const key = String(issue.path[0] ?? "environment");
  // zod's own messages name the type or the allowed options, never the input;
  // an unset key is reported as such so the message does not depend on them.
  return { key, message: env[key] === undefined ? "is required" : issue.message };
}

export function validateEnvironment<Shape extends z.ZodRawShape>(
  schema: EnvSchema<Shape>,
  env: EnvironmentVariables,
  options: LoadOptions = {},
): LoadedConfig<z.infer<z.ZodObject<Shape>>> {
  const production = env["NODE_ENV"] === "production";
  const issues: ConfigIssue[] = [];

  const parsed = schema.object.safeParse(env);
  if (parsed.success) {
    const context: RefineContext = {
      production,
      issue: (key, message) => {
        issues.push({ key, message });
      },
    };
    for (const refine of schema.refinements) {
      refine(parsed.data, context);
    }
  } else {
    issues.push(...parsed.error.issues.map((issue) => describe(issue, env)));
  }

  if (production) {
    for (const [key, developmentValue] of Object.entries(schema.developmentDefaults)) {
      if (env[key] === developmentValue) {
        issues.push({ key, message: "is a development default from .env.example, which production refuses" });
      }
    }
  }

  if (issues.length > 0 || !parsed.success) {
    throw new ConfigError(issues);
  }

  const known = new Set([...declaredKeys(), ...schema.keys, ...(options.extraKeys ?? [])]);
  const unknown = Object.keys(env)
    .filter((key) => key.startsWith(SLUGBASE_PREFIX) && !known.has(key))
    .sort();
  return {
    config: parsed.data,
    warnings: unknown.length === 0 ? [] : [`Unknown ${SLUGBASE_PREFIX}* environment keys are ignored: ${unknown.join(", ")}`],
  };
}

/** Validates the environment for one process type; throws a ConfigError naming every bad key. */
export function loadConfig<Type extends ProcessType>(
  type: Type,
  env: EnvironmentVariables,
): LoadedConfig<ConfigByProcess[Type]> {
  return validateEnvironment(envSchemas[type] as EnvSchema, env) as LoadedConfig<ConfigByProcess[Type]>;
}
