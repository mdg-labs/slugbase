// `pnpm dev:env` (doc 08 section 1.3): copies .env.example to .env and fills
// SESSION_SECRET and ENCRYPTION_KEY with generated development values. It
// refuses to overwrite an existing .env and never prints a value.
//
// node scripts/dev-env.mjs [directory]   (default: the repository root)

import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const GENERATED = {
  SESSION_SECRET: () => randomBytes(48).toString("base64url"),
  ENCRYPTION_KEY: () => randomBytes(32).toString("base64"),
};

export function renderDevEnv(template, generate = GENERATED) {
  const filled = new Set();
  const lines = template.split("\n").map((line) => {
    const key = /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1];
    if (key === undefined || !(key in generate)) {
      return line;
    }
    filled.add(key);
    return `${key}=${generate[key]()}`;
  });
  const missing = Object.keys(generate).filter((key) => !filled.has(key));
  if (missing.length > 0) {
    throw new Error(`.env.example has no line for ${missing.join(", ")}`);
  }
  return lines.join("\n");
}

export function createDevEnv(directory) {
  const content = renderDevEnv(readFileSync(join(directory, ".env.example"), "utf8"));
  try {
    // "wx" fails if the file exists, so an existing .env is never overwritten.
    writeFileSync(join(directory, ".env"), content, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(".env already exists; remove it first to generate a new one", { cause: error });
    }
    throw error;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
  try {
    createDevEnv(directory);
    process.stdout.write("dev:env: created .env from .env.example with generated SESSION_SECRET and ENCRYPTION_KEY\n");
  } catch (error) {
    process.stderr.write(`dev:env: ${error instanceof Error ? error.message : "failed"}\n`);
    process.exitCode = 1;
  }
}
