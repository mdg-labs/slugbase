import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ESLint, type Linter } from "eslint";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../../../..");

// The repository's own block, parsed without type information: the probes are
// not files of any tsconfig.
const { processEnvRules } = (await import(pathToFileURL(resolve(ROOT, "eslint.config.js")).href)) as {
  processEnvRules: Linter.Config;
};
const eslint = new ESLint({
  cwd: ROOT,
  overrideConfigFile: true,
  overrideConfig: [{ files: ["**/*.ts"], languageOptions: { parser: tseslint.parser } }, processEnvRules],
});

async function lint(code: string, file: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: resolve(ROOT, file) });
  if (result === undefined) {
    throw new Error("no lint result");
  }
  return result.messages.map((message) => message.ruleId ?? `parse error: ${message.message}`);
}

const SOURCE = "packages/core/src/probe.ts";

describe("reading process.env", () => {
  it.each([
    ["a member access", "export const a = process.env.PORT;"],
    ["a bracket access", 'export const a = process.env["PORT"];'],
    ["an optional chain", "export const a = process?.env?.PORT;"],
    ["a computed key", 'export const a = process["env"].PORT;'],
    ["a template key", "export const a = process[`env`].PORT;"],
    ["a variable key", 'const key = "env"; export const a = process[key];'],
    ["a destructuring", "const { env } = process; export const a = env;"],
    ["an alias", "const p = process; export const a = p;"],
    ["a call argument", "export const a = Object.keys(process);"],
    ["the global object", "export const a = globalThis.process.env;"],
    ["the global object by key", 'export const a = globalThis["process"];'],
    ["a named import", 'import { env } from "node:process"; export const a = env;'],
    ["a default import", 'import process from "node:process"; export const a = process.env;'],
    ["a require", 'export const a = require("node:process");'],
    ["a dynamic import", 'export const a = await import("process");'],
  ])("is refused in package source through %s", async (_name, code) => {
    expect((await lint(code, SOURCE)).length).toBeGreaterThan(0);
  });

  it("is refused in app source other than the entry", async () => {
    expect((await lint("export const a = process.env.PORT;", "apps/slugbase/src/other.ts")).length).toBeGreaterThan(0);
  });

  it.each([
    ["the config module", "packages/server/src/config/probe.ts"],
    ["the entry of apps/slugbase", "apps/slugbase/src/main.ts"],
  ])("is allowed in %s", async (_name, file) => {
    expect(await lint("export const a = process.env.PORT;", file)).toEqual([]);
  });

  it("leaves other uses of process alone", async () => {
    expect(await lint('process.on("SIGTERM", () => { process.exitCode = 1; }); process.exit(0);', SOURCE)).toEqual([]);
  });

  it("leaves a property or a type member named process alone", async () => {
    const code = 'export const a = { process: 0 }; export const b = a.process; export interface C { process: string }';
    expect(await lint(code, SOURCE)).toEqual([]);
  });

  it("does not restrict tests", async () => {
    expect(await lint("export const a = process.env.PORT;", "packages/core/test/probe.test.ts")).toEqual([]);
  });
});
