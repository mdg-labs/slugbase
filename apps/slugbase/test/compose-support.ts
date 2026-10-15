import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse, type SchemaOptions, type YAMLSeq } from "yaml";

// Shared by the compose tests. `loadCompose` reads compose.yml with a YAML parser
// and resolves the interpolation forms the file uses, so the structure of the
// stack is checked without the Docker CLI. It supports exactly `${NAME:-default}`
// and `${NAME:?message}`, and rejects any other `$` in the file, so that it
// cannot drift from what Docker Compose does with the file unnoticed.
//
// An override file (compose.pg17.yml) is merged the way Docker Compose merges
// the `-f` files it is given, for the forms the overrides use: mappings merge
// key by key, a list is appended to the list before it, any other value is
// replaced, and a list tagged `!override` replaces the list before it.

export const ROOT = resolve(import.meta.dirname, "../../..");
export const COMPOSE_FILE = join(ROOT, "compose.yml");
export const COMPOSE_PG17_FILE = join(ROOT, "compose.pg17.yml");

export const APP_PASSWORD = "app-pw-0123456789abcdef";
export const MIGRATOR_PASSWORD = "migrator-pw-0123456789abcdef";
export const SUPERUSER_PASSWORD = "superuser-pw-0123456789abcdef";

/** The keys of `.env.example` whose development values an operator replaces. */
export const OPERATOR_VALUES: ReadonlyMap<string, string> = new Map([
  ["APP_ORIGIN", "https://bookmarks.example.com"],
  ["SESSION_SECRET", "session-secret-of-the-test-run-at-least-32-characters"],
  ["ENCRYPTION_KEY", "ZmFrZS1lbmNyeXB0aW9uLWtleS1mb3ItdGhlLXRlc3Q="],
  ["ENCRYPTION_KEY_ID", "k1"],
  ["POSTGRES_PASSWORD", SUPERUSER_PASSWORD],
  ["APP_DB_PASSWORD", APP_PASSWORD],
  ["MIGRATOR_DB_PASSWORD", MIGRATOR_PASSWORD],
]);

export function parseEnv(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match?.[1] !== undefined) {
      entries.set(match[1], match[2] ?? "");
    }
  }
  return entries;
}

/** `.env.example` as an operator would use it: copied, then the required values set. */
export function exampleKeys(): Map<string, string> {
  return parseEnv(readFileSync(join(ROOT, ".env.example"), "utf8"));
}

export function operatorEnv(): Map<string, string> {
  const entries = exampleKeys();
  for (const [key, value] of OPERATOR_VALUES) {
    entries.set(key, value);
  }
  return entries;
}

const SUPPORTED = /\$\{([A-Z][A-Z0-9_]*)(?::-([^}$]*)|:\?([^}$]*))\}/g;

/** Resolves `${NAME:-default}` and `${NAME:?message}`; any other use of `$` throws. */
export function interpolate(text: string, env: ReadonlyMap<string, string>): string {
  const resolved = text.replace(SUPPORTED, (_all, name: string, fallback: string | undefined, message: string | undefined) => {
    const value = env.get(name);
    if (value !== undefined && value !== "") {
      return value;
    }
    if (message !== undefined) {
      throw new Error(`required ${name} is not set: ${message}`);
    }
    return fallback ?? "";
  });
  if (resolved.includes("$")) {
    throw new Error(`unsupported interpolation in ${JSON.stringify(text)}: only \${NAME:-default} and \${NAME:?message} are resolved`);
  }
  return resolved;
}

function resolveValue(value: unknown, env: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") {
    return interpolate(value, env);
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveValue(item, env));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [interpolate(key, env), resolveValue(item, env)]));
  }
  return value;
}

export interface ServiceConfig {
  image: string;
  command: string[];
  user?: string;
  read_only?: boolean;
  restart?: string;
  tmpfs?: string[];
  ports?: string[];
  /** A key written without a value takes the environment's value, and is absent when the environment has none. */
  environment: Record<string, string>;
  env_file?: { path: string; required: boolean }[];
  depends_on?: Record<string, { condition: string }>;
  healthcheck?: { test: string[] };
  volumes?: string[];
  build?: { context: string; dockerfile: string };
}

export interface ComposeConfig {
  services: Record<"postgres" | "slugbase" | "slugbase-worker", ServiceConfig>;
}

/** A list that replaces the list of the same key in the file before it (`!override`). */
class Replacement {
  constructor(readonly items: unknown[]) {}
}

// The `!override` tag of Docker Compose, on a list.
const OVERRIDE_TAGS: SchemaOptions["customTags"] = [
  {
    tag: "!override",
    // eslint-disable-next-line slugbase/no-forbidden-vocabulary -- the key is the yaml package's name for a tag on a list or mapping
    collection: "seq",
    resolve: (seq: YAMLSeq) => new Replacement(seq.toJSON()),
  },
];

function isMapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Replacement);
}

function merge(base: unknown, over: unknown): unknown {
  if (over instanceof Replacement) {
    return over.items;
  }
  if (isMapping(base) && isMapping(over)) {
    const merged: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(over)) {
      merged[key] = key in base ? merge(base[key], value) : value;
    }
    return merged;
  }
  if (Array.isArray(base) && Array.isArray(over)) {
    return [...(base as unknown[]), ...(over as unknown[])];
  }
  return over;
}

function readYaml(file: string): unknown {
  return parse(readFileSync(file, "utf8"), { merge: true, customTags: OVERRIDE_TAGS });
}

/**
 * compose.yml with anchors and merge keys expanded, `overrides` merged over it in order, and `env` applied.
 * Throws on a missing required key.
 */
export function loadCompose(env: ReadonlyMap<string, string>, overrides: readonly string[] = [], base: string = COMPOSE_FILE): ComposeConfig {
  let document = readYaml(base);
  for (const file of overrides) {
    document = merge(document, readYaml(file));
  }
  const config = resolveValue(document, env) as ComposeConfig;
  for (const service of Object.values(config.services)) {
    service.environment = Object.fromEntries(
      Object.entries((service.environment as Record<string, string | null> | undefined) ?? {}).flatMap(([key, value]): [string, string][] => {
        const taken = value ?? env.get(key);
        return taken === undefined ? [] : [[key, taken]];
      }),
    );
  }
  return config;
}

/** True when a Docker CLI with the compose plugin answers; the cases that need Compose itself run only then. */
export const hasDockerCompose: boolean = spawnSync("docker", ["compose", "version"], { stdio: "ignore", timeout: 30_000 }).status === 0;
