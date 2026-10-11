import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ESLint, type Linter } from "eslint";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";
import { ROOT, SUBPROCESS_TIMEOUT_MS } from "./run.ts";

const IMPORT = "slugbase/import-boundaries";
const RAW_IO = "slugbase/no-raw-io";
const HTML = "slugbase/no-unsafe-html";

interface RepoConfig {
  vocabularyRules: Linter.Config;
  boundaryRules: Linter.Config;
}

const repoConfig = (await import(pathToFileURL(resolve(ROOT, "eslint.config.js")).href)) as RepoConfig;

// The boundary rules decide by file path alone, so a text linted under a
// packages/<name>/ path is checked as that package's file without committing a
// fixture there. The parser-only config keeps files that do not exist out of
// the type-aware project.
const eslint = new ESLint({
  cwd: ROOT,
  overrideConfigFile: true,
  overrideConfig: [
    { files: ["**/*.{ts,tsx,js}"], languageOptions: { parser: tseslint.parser } },
    repoConfig.vocabularyRules,
    repoConfig.boundaryRules,
  ],
});

// The repository's own config, as `pnpm lint` runs it, on files that exist.
const repoEslint = new ESLint({ cwd: ROOT });

async function ruleIds(file: string, code: string, linter: ESLint = eslint): Promise<string[]> {
  const [result] = await linter.lintText(code, { filePath: resolve(ROOT, file) });
  if (result === undefined) {
    throw new Error(`no lint result for ${file}`);
  }
  return result.messages.filter((m) => m.severity === 2).map((m) => m.ruleId ?? `parse-error: ${m.message}`);
}

async function passes(file: string, code: string): Promise<void> {
  expect(await ruleIds(file, code)).toEqual([]);
}

async function failsWith(file: string, code: string, rule: string): Promise<void> {
  expect(await ruleIds(file, code)).toContain(rule);
}

describe("egress ban (T6)", () => {
  it("fails undici under packages/server/src", async () => {
    await failsWith("packages/server/src/fixture.ts", 'import { request } from "undici";\nvoid request;\n', IMPORT);
  });

  it("passes the same import under packages/adapters/src/egress", async () => {
    await passes("packages/adapters/src/egress/fixture.ts", 'import { request } from "undici";\nvoid request;\n');
  });

  it("fails the same import elsewhere in packages/adapters", async () => {
    await failsWith("packages/adapters/src/smtp/fixture.ts", 'import { request } from "undici";\nvoid request;\n', IMPORT);
  });

  it.each(["node:http", "node:https", "http", "https", "node:http2", "undici"])("fails %s in the server", async (spec) => {
    await failsWith("packages/server/src/fixture.ts", `import * as lib from "${spec}";\nvoid lib;\n`, IMPORT);
  });

  it.each([
    ["require", 'const lib = require("undici");\nvoid lib;\n'],
    ["dynamic import", 'const lib = await import("node:http");\nvoid lib;\n'],
    ["require of a static template", "const lib = require(`undici`);\nvoid lib;\n"],
    ["dynamic import of a static template", "const lib = await import(`node:http`);\nvoid lib;\n"],
    ["re-export", 'export * from "node:https";\n'],
    ["named re-export", 'export { request } from "undici";\n'],
    ["import equals", 'import lib = require("undici");\nvoid lib;\n'],
    ["type import", 'export type Agent = import("undici").Agent;\n'],
  ])("fails an HTTP module reached by %s", async (_name, code) => {
    await failsWith("packages/server/src/fixture.ts", code, IMPORT);
  });

  it("fails the global fetch outside the egress folder", async () => {
    await failsWith("packages/server/src/fixture.ts", 'void fetch("https://example.com");\n', RAW_IO);
    await failsWith("packages/web/src/fixture.ts", "export const send = fetch;\n", RAW_IO);
    await failsWith("packages/web/src/fixture.ts", 'void globalThis.fetch("https://example.com");\n', RAW_IO);
    await failsWith("packages/web/src/fixture.ts", 'void window["fetch"]("https://example.com");\n', RAW_IO);
  });

  it.each([
    ["destructured", 'const { fetch } = globalThis;\nvoid fetch("https://example.com");\n'],
    ["destructured and renamed", 'const { fetch: send } = globalThis;\nvoid send("https://example.com");\n'],
    ["destructured from window", 'const { fetch } = window;\nvoid fetch;\n'],
    ["destructured by string key", 'const { "fetch": send } = self;\nvoid send;\n'],
    ["destructured with a default", "const { fetch = noop } = global;\nvoid fetch;\nfunction noop() {}\n"],
    ["destructured by assignment", "let send: unknown;\n({ fetch: send } = globalThis);\nvoid send;\n"],
    ["destructured in a parameter", "export function run({ fetch } = globalThis) {\n  void fetch;\n}\n"],
    ["destructured from an asserted object", "const { fetch } = globalThis as typeof globalThis;\nvoid fetch;\n"],
    ["asserted object", 'void (globalThis as typeof globalThis).fetch("https://example.com");\n'],
    ["non-null object", 'void globalThis!.fetch("https://example.com");\n'],
    ["satisfies object", 'void (globalThis satisfies object as typeof globalThis).fetch("https://example.com");\n'],
    ["angle-bracket object", 'void (<typeof globalThis>globalThis).fetch("https://example.com");\n'],
    ["optional object", 'void globalThis?.fetch("https://example.com");\n'],
    ["optional member", 'void globalThis.fetch?.("https://example.com");\n'],
    ["nested assertions", 'void ((globalThis as object)! as typeof globalThis).fetch("https://example.com");\n'],
  ])("fails the global fetch reached %s", async (_name, code) => {
    await failsWith("packages/server/src/fixture.ts", code, RAW_IO);
  });

  it("does not flag destructuring other members or other objects", async () => {
    await passes(
      "packages/server/src/fixture.ts",
      "declare const options: { fetch: () => void };\nconst { fetch } = options;\nconst { setTimeout } = globalThis;\nvoid fetch;\nvoid setTimeout;\n",
    );
  });

  it("passes the global fetch inside the egress folder", async () => {
    await passes("packages/adapters/src/egress/fixture.ts", 'void fetch("https://example.com");\n');
    await passes("packages/adapters/src/egress/fixture.ts", 'const { fetch: send } = globalThis;\nvoid send;\n');
  });

  it("does not flag a local binding or a method named fetch", async () => {
    await passes(
      "packages/server/src/fixture.ts",
      "export function run(app: { fetch(request: Request): Promise<Response> }, request: Request) {\n  return app.fetch(request);\n}\n" +
        "export function shadow(fetch: () => void) {\n  fetch();\n}\n",
    );
  });

  it("applies to apps too", async () => {
    await failsWith("apps/slugbase/src/fixture.ts", 'import "node:http";\n', IMPORT);
  });

  it("leaves files outside packages and apps alone", async () => {
    await passes("tooling/fixture.ts", 'import "undici";\nvoid fetch;\n');
  });
});

describe("database ban (T1)", () => {
  it("fails postgres under packages/core/src", async () => {
    await failsWith("packages/core/src/fixture.ts", 'import postgres from "postgres";\nvoid postgres;\n', IMPORT);
  });

  it("fails @slugbase/adapters under packages/server/src", async () => {
    await failsWith("packages/server/src/fixture.ts", 'import "@slugbase/adapters";\n', IMPORT);
  });

  it.each(["postgres", "drizzle-orm", "drizzle-orm/pg-core", "pg"])("fails %s outside packages/db", async (spec) => {
    for (const file of ["packages/server/src/fixture.ts", "packages/adapters/src/fixture.ts", "packages/testing/src/fixture.ts"]) {
      await failsWith(file, `import "${spec}";\n`, IMPORT);
    }
  });

  it.each(["postgres", "drizzle-orm", "drizzle-orm/pg-core"])("passes %s inside packages/db", async (spec) => {
    await passes("packages/db/src/fixture.ts", `import "${spec}";\n`);
  });

  it("fails a drizzle or postgres call outside packages/db, passes it inside", async () => {
    const code = "declare const drizzle: (client: unknown) => unknown;\ndeclare const postgres: (url: string) => unknown;\nvoid drizzle(postgres('x'));\n";
    expect(await ruleIds("packages/server/src/fixture.ts", code)).toEqual([RAW_IO, RAW_IO]);
    await passes("packages/db/src/fixture.ts", code);
  });

  it.each([
    "node:net",
    "node:http",
    "node:https",
    "node:tls",
    "net",
    "undici",
    "postgres",
    "drizzle-orm",
    "pg",
  ])("fails %s in core", async (spec) => {
    await failsWith("packages/core/src/fixture.ts", `import "${spec}";\n`, IMPORT);
  });

  it("fails the global fetch in core", async () => {
    await failsWith("packages/core/src/fixture.ts", "void fetch;\n", RAW_IO);
  });

  it("lets core import node:crypto and node:fs", async () => {
    await passes("packages/core/src/fixture.ts", 'import "node:crypto";\nimport "node:fs";\n');
  });
});

describe("package boundary table (doc 09 section 2.1)", () => {
  const PACKAGES = ["contracts", "core", "db", "adapters", "server", "web", "ui", "email"];
  const allowed: Record<string, string[]> = {
    contracts: [],
    core: ["contracts"],
    db: ["core", "contracts"],
    adapters: ["core", "contracts", "db"],
    server: ["core", "db", "contracts"],
    web: ["contracts", "ui"],
    ui: [],
    email: [],
  };

  const cases = PACKAGES.flatMap((from) =>
    PACKAGES.filter((to) => to !== from).map((to) => ({ from, to, ok: allowed[from]?.includes(to) === true })),
  );

  it.each(cases)("$from importing $to is allowed: $ok", async ({ from, to, ok }) => {
    const ids = await ruleIds(`packages/${from}/src/fixture.ts`, `import "@slugbase/${to}";\n`);
    expect(ids).toEqual(ok ? [] : [IMPORT]);
  });

  it("lets an app import every package", async () => {
    for (const to of PACKAGES) {
      await passes("apps/slugbase/src/fixture.ts", `import "@slugbase/${to}";\n`);
    }
  });

  it("applies the table to type-only imports and re-exports", async () => {
    await failsWith("packages/server/src/fixture.ts", 'import type { Adapter } from "@slugbase/adapters";\nexport type { Adapter };\n', IMPORT);
    await failsWith("packages/web/src/fixture.ts", 'export * from "@slugbase/core";\n', IMPORT);
  });

  it("rejects the app package and unknown workspace packages", async () => {
    await failsWith("packages/server/src/fixture.ts", 'import "@slugbase/unknown";\n', IMPORT);
    await failsWith("apps/slugbase/src/fixture.ts", 'import "@slugbase/unknown";\n', IMPORT);
  });

  it("rejects a package that is not in the table", async () => {
    await failsWith("packages/newcomer/src/fixture.ts", 'import "@slugbase/contracts";\n', IMPORT);
  });

  it("allows the public entry of db to adapters and rejects its internals", async () => {
    await passes("packages/adapters/src/fixture.ts", 'import "@slugbase/db";\n');
    await failsWith("packages/adapters/src/fixture.ts", 'import "@slugbase/db/src/schema";\n', IMPORT);
    await failsWith("packages/adapters/src/fixture.ts", 'import "@slugbase/db/dist/index.js";\n', IMPORT);
    await failsWith("apps/slugbase/src/fixture.ts", 'import "@slugbase/db/src/schema";\n', IMPORT);
  });

  it("rejects a relative import into another package", async () => {
    await failsWith("packages/adapters/src/fixture.ts", 'import "../../db/src/index.ts";\n', IMPORT);
    await failsWith("packages/server/test/fixture.ts", 'import "../../core/src/index.ts";\n', IMPORT);
    await passes("packages/adapters/src/egress/fixture.ts", 'import "../index.ts";\nimport "./other.ts";\n');
  });

  it("limits contracts to zod", async () => {
    await passes("packages/contracts/src/fixture.ts", 'import { z } from "zod";\nimport "zod/v4";\nimport "./other.ts";\nvoid z;\n');
    await failsWith("packages/contracts/src/fixture.ts", 'import "lodash";\n', IMPORT);
    await failsWith("packages/contracts/src/fixture.ts", 'import "node:fs";\n', IMPORT);
    await failsWith("packages/contracts/src/fixture.ts", 'import "../../../vitest.shared.ts";\n', IMPORT);
    await passes("packages/contracts/test/fixture.test.ts", 'import "vitest";\nimport "node:fs";\n');
  });
});

describe("@slugbase/testing", () => {
  it.each([
    "packages/server/src/fixture.ts",
    "packages/web/src/components/fixture.tsx",
    "apps/slugbase/src/fixture.ts",
  ])("fails in production code: %s", async (file) => {
    await failsWith(file, 'import "@slugbase/testing";\n', IMPORT);
  });

  it.each([
    "packages/server/src/fixture.test.ts",
    "packages/server/src/deep/fixture.spec.tsx",
    "packages/server/test/helpers/fixture.ts",
    "packages/ui/test/fixture.ts",
    "apps/slugbase/test/fixture.ts",
    "apps/slugbase/scripts/fixture.ts",
  ])("passes in test code and app tooling: %s", async (file) => {
    await passes(file, 'import "@slugbase/testing";\nimport "@slugbase/testing/db";\n');
  });

  it("rejects a path the testing package does not export", async () => {
    await failsWith("packages/server/test/fixture.ts", 'import "@slugbase/testing/src/db";\n', IMPORT);
  });
});

describe("unsanitised HTML (T14)", () => {
  const DANGEROUS = 'export const View = () => <div dangerouslySetInnerHTML={{ __html: "x" }} />;\n';

  it("fails dangerouslySetInnerHTML and innerHTML", async () => {
    await failsWith("packages/web/src/fixture.tsx", DANGEROUS, HTML);
    await failsWith("packages/web/src/fixture.tsx", 'document.body.innerHTML = "x";\n', HTML);
    await failsWith("packages/ui/src/fixture.ts", 'const { innerHTML } = document.body;\nvoid innerHTML;\n', HTML);
    await failsWith("packages/ui/src/fixture.ts", 'document.body["innerHTML"] = "x";\n', HTML);
  });

  it("accepts a disable comment that carries an issue link", async () => {
    await passes("packages/web/src/fixture.tsx", `// eslint-disable-next-line ${HTML} -- sanitised upstream, see #123\n${DANGEROUS}`);
    await passes(
      "packages/web/src/fixture.tsx",
      `// eslint-disable-next-line ${HTML} -- https://github.com/mdg-labs/slugbase/issues/123\n${DANGEROUS}`,
    );
  });

  it("rejects a disable comment without an issue link", async () => {
    for (const comment of [
      `// eslint-disable-next-line ${HTML}`,
      `// eslint-disable-next-line ${HTML} -- it is fine`,
      `// eslint-disable-next-line -- it is fine`,
      "// eslint-disable-next-line",
    ]) {
      await failsWith("packages/web/src/fixture.tsx", `${comment}\n${DANGEROUS}`, HTML);
    }
    await failsWith("packages/web/src/fixture.tsx", `/* eslint-disable -- trusted */\n${DANGEROUS}`, HTML);
    await failsWith("packages/web/src/fixture.tsx", `${DANGEROUS.trimEnd()} // eslint-disable-line -- trusted\n`, HTML);
  });

  it.each([
    '"off"',
    "0",
    '["off"]',
    "[0]",
    '"warn"',
    "1",
    '"error"',
  ])("rejects inline configuration of the rule without an issue link: %s", async (setting) => {
    const comment = `/* eslint ${HTML}: ${setting} */`;
    await failsWith("packages/web/src/fixture.tsx", `${comment}\n${DANGEROUS}`, HTML);
    await failsWith("packages/ui/src/fixture.ts", `${comment}\ndocument.body.innerHTML = "x";\n`, HTML);
    await failsWith("packages/web/src/fixture.tsx", `/* eslint ${HTML}: ${setting} -- it is fine */\n${DANGEROUS}`, HTML);
    await failsWith("packages/web/src/fixture.tsx", `/*eslint\n  other/rule: "off",\n  ${HTML}: ${setting}\n*/\n${DANGEROUS}`, HTML);
  });

  it("rejects inline configuration even when the file has no unsafe HTML", async () => {
    await failsWith("packages/web/src/fixture.tsx", `/* eslint ${HTML}: "off" */\nexport {};\n`, HTML);
  });

  it("accepts inline configuration that carries an issue link", async () => {
    await passes("packages/web/src/fixture.tsx", `/* eslint ${HTML}: "off" -- sanitised upstream, see #123 */\n${DANGEROUS}`);
  });

  it("ignores inline configuration that names other rules or sits outside governed folders", async () => {
    await passes("packages/web/src/fixture.tsx", '/* eslint no-console: "off" */\nexport {};\n');
    await passes("packages/web/src/fixture.tsx", `/* eslint-disable no-console -- see ${HTML} */\nexport {};\n`);
    await passes("tooling/fixture.ts", `/* eslint ${HTML}: "off" */\nexport {};\n`);
  });

  it("rejects inline configuration through the repository config", { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    expect(await ruleIds("packages/ui/src/index.ts", `/* eslint ${HTML}: 0 */\ndocument.body.innerHTML = '';\nexport {};\n`, repoEslint)).toContain(HTML);
  });

  it("accepts a file-wide disable with an issue link", async () => {
    await passes("packages/web/src/fixture.tsx", `/* eslint-disable ${HTML} -- #123 */\n${DANGEROUS}`);
  });
});

describe("the repository config", { timeout: SUBPROCESS_TIMEOUT_MS }, () => {
  it("applies the rules through eslint.config.js", async () => {
    const real = (file: string, code: string): Promise<string[]> => ruleIds(file, code, repoEslint);
    expect(await real("packages/server/src/index.ts", 'import "undici";\nexport {};\n')).toContain(IMPORT);
    expect(await real("packages/core/src/index.ts", 'import "postgres";\nexport {};\n')).toContain(IMPORT);
    expect(await real("packages/server/src/index.ts", 'import "@slugbase/adapters";\nexport {};\n')).toContain(IMPORT);
    expect(await real("packages/web/src/index.ts", "document.body.innerHTML = '';\nexport {};\n")).toContain(HTML);
    expect(await real("packages/server/src/index.ts", "export {};\n")).toEqual([]);
  });
});

describe("CLAUDE.md sweeps", { timeout: SUBPROCESS_TIMEOUT_MS }, () => {
  function sweep(patterns: string[], glob: string): string[] {
    const result = spawnSync("git", ["grep", "-l", ...patterns.flatMap((p) => ["-e", p]), "--", glob], {
      cwd: ROOT,
      encoding: "utf8",
    });
    // git grep exits 1 for "no match" and above that for a failure.
    if (result.status !== 0 && result.status !== 1) {
      throw new Error(`git grep failed: ${result.stderr}`);
    }
    return result.stdout.split("\n").filter((line) => line !== "");
  }

  it("sweep-raw-fetch lists nothing outside packages/adapters/src/egress/", () => {
    const files = sweep(["fetch(", "node:http", "undici"], "packages/**/*.ts");
    expect(files.filter((file) => !file.startsWith("packages/adapters/src/egress/"))).toEqual([]);
  });

  it("sweep-raw-db lists nothing outside packages/db", () => {
    const files = sweep(["drizzle(", "postgres("], "packages/**/*.ts");
    expect(files.filter((file) => !file.startsWith("packages/db/"))).toEqual([]);
  });

  it("sweep-html lists nothing", () => {
    expect(sweep(["dangerouslySetInnerHTML", "innerHTML"], "packages/**/*.tsx")).toEqual([]);
  });
});
