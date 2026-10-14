import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ESLint, type Linter } from "eslint";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";
import { findRawOutbound } from "../boundaries/raw-outbound.ts";
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

describe("socket and DNS confinement (T6)", () => {
  const SERVER = "packages/server/src/fixture.ts";
  const EGRESS = "packages/adapters/src/egress/fixture.ts";
  const TEST_DIR = "packages/server/test/fixture.ts";
  const TEST_FILE = "packages/server/src/fixture.test.ts";

  it.each(["net", "tls", "dns", "dgram", "dns/promises"])("fails %s with and without the node: prefix", async (spec) => {
    await failsWith(SERVER, `import * as lib from "node:${spec}";\nvoid lib;\n`, IMPORT);
    await failsWith(SERVER, `import * as lib from "${spec}";\nvoid lib;\n`, IMPORT);
  });

  it.each([
    ["require", 'const lib = require("node:net");\nvoid lib;\n'],
    ["dynamic import", 'const lib = await import("node:tls");\nvoid lib;\n'],
    ["re-export", 'export * from "node:dgram";\n'],
    ["import equals", 'import lib = require("node:dns");\nvoid lib;\n'],
    ["type import", 'export type Socket = import("node:net").Socket;\n'],
  ])("fails a socket module reached by %s", async (_name, code) => {
    await failsWith(SERVER, code, IMPORT);
  });

  it("fails the module loader builtin, the gateway to createRequire", async () => {
    await failsWith(SERVER, 'import { createRequire } from "node:module";\nvoid createRequire;\n', IMPORT);
    await failsWith("packages/web/src/fixture.ts", 'import { createRequire } from "module";\nvoid createRequire;\n', IMPORT);
  });

  it.each(["axios", "node-fetch", "got", "ky", "superagent", "ws", "socket.io-client", "eventsource", "@hapi/wreck"])(
    "fails the third-party client %s outside egress",
    async (spec) => {
      await failsWith(SERVER, `import lib from "${spec}";\nvoid lib;\n`, IMPORT);
    },
  );

  it.each([
    ["getBuiltinModule", 'const net = process.getBuiltinModule("node:net");\nvoid net;\n'],
    ["a string key", 'const load = process["getBuiltinModule"];\nvoid load;\n'],
    ["a static template key", "const load = process[`getBuiltinModule`];\nvoid load;\n"],
    ["destructuring", "const { getBuiltinModule } = process;\nvoid getBuiltinModule;\n"],
    ["globalThis.process", 'void globalThis.process.getBuiltinModule("node:tls");\n'],
  ])("fails a dynamic builtin load by %s", async (_name, code) => {
    await failsWith(SERVER, code, RAW_IO);
  });

  it.each(["WebSocket", "EventSource", "WebTransport", "WebSocketStream"])("fails the %s global", async (name) => {
    await failsWith(SERVER, `const socket = new ${name}("wss://example.com");\nvoid socket;\n`, RAW_IO);
    await failsWith(SERVER, `const socket = new globalThis.${name}("wss://example.com");\nvoid socket;\n`, RAW_IO);
    await failsWith(SERVER, `const { ${name}: Socket } = globalThis;\nvoid Socket;\n`, RAW_IO);
    await failsWith("packages/web/src/fixture.ts", `const socket = new ${name}("/stream");\nvoid socket;\n`, RAW_IO);
  });

  it("does not flag a member or a local binding of the same name", async () => {
    await passes(SERVER, "declare const sockets: { WebSocket: number };\nvoid sockets.WebSocket;\nexport function run(EventSource: () => void) {\n  EventSource();\n}\n");
  });

  it("passes the same fixtures under the egress folder", async () => {
    await passes(EGRESS, 'import * as net from "node:net";\nimport * as dns from "node:dns/promises";\nvoid net;\nvoid dns;\n');
    await passes(EGRESS, 'import { createRequire } from "node:module";\nvoid createRequire;\n');
    await passes(EGRESS, 'void process.getBuiltinModule("node:net");\nvoid new WebSocket("wss://example.com");\n');
  });

  it.each([TEST_DIR, TEST_FILE, "apps/slugbase/test/fixture.ts", "apps/slugbase/scripts/fixture.ts"])(
    "passes the same fixtures in test and development code: %s",
    async (file) => {
      await passes(file, 'import { connect } from "node:net";\nimport { createRequire } from "node:module";\nvoid connect;\nvoid createRequire;\n');
      await passes(file, 'void process.getBuiltinModule("node:net");\nvoid new WebSocket("wss://example.com");\n');
    },
  );

  it("exempts the trusted-proxy module for node:net and the pg-boss migrate step for node:module only", async () => {
    await passes("packages/server/src/http/trusted-proxy.ts", 'import { isIP, isIPv6 } from "node:net";\nvoid isIP;\nvoid isIPv6;\n');
    await failsWith("packages/server/src/http/trusted-proxy.ts", 'import "node:dns";\n', IMPORT);
    await failsWith("packages/server/src/http/trusted-proxy.ts", 'import "node:module";\n', IMPORT);
    await failsWith("packages/server/src/http/other.ts", 'import { isIP } from "node:net";\nvoid isIP;\n', IMPORT);
    await passes("packages/server/src/migrate/pgboss.ts", 'import { createRequire } from "node:module";\nvoid createRequire;\n');
    await failsWith("packages/server/src/migrate/pgboss.ts", 'import "node:net";\n', IMPORT);
    await failsWith("packages/server/src/migrate/pgboss.ts", 'void process.getBuiltinModule("node:net");\n', RAW_IO);
  });

  it("still bans the HTTP builtins in test code", async () => {
    await failsWith(TEST_DIR, 'import "node:http";\n', IMPORT);
  });

  it("applies through eslint.config.js as `pnpm lint` runs it", { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    expect(await ruleIds("packages/server/src/index.ts", 'import "node:net";\nexport {};\n', repoEslint)).toContain(IMPORT);
    expect(await ruleIds("packages/server/src/index.ts", 'void process.getBuiltinModule("node:net");\nexport {};\n', repoEslint)).toContain(RAW_IO);
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

describe("@slugbase/testing-ports", () => {
  it.each([
    "packages/server/src/fixture.ts",
    "packages/core/src/fixture.ts",
    "apps/slugbase/src/fixture.ts",
  ])("fails in production code: %s", async (file) => {
    await failsWith(file, 'import "@slugbase/testing-ports";\n', IMPORT);
  });

  it.each([
    "packages/core/test/fixture.test.ts",
    "packages/core/test/helpers/fixture.ts",
    "apps/slugbase/test/fixture.ts",
    "packages/testing/src/fixture.ts",
  ])("passes in test code, app tooling and the testing package: %s", async (file) => {
    await passes(file, 'import "@slugbase/testing-ports";\n');
  });

  it("imports no workspace package", async () => {
    await failsWith("packages/testing-ports/src/fixture.ts", 'import "@slugbase/core";\n', IMPORT);
  });

  it("keeps the testing package's src from importing @slugbase/testing itself", async () => {
    await failsWith("packages/testing/src/fixture.ts", 'import "@slugbase/testing";\n', IMPORT);
  });
});

describe("@slugbase/db/testing (T1)", () => {
  const HARNESS = 'import "@slugbase/db/testing";\n';

  it.each([
    "packages/server/src/fixture.ts",
    "packages/adapters/src/fixture.ts",
    "packages/adapters/src/egress/fixture.ts",
    "packages/web/src/components/fixture.tsx",
    "apps/slugbase/src/fixture.ts",
  ])("fails in production code: %s", async (file) => {
    await failsWith(file, HARNESS, IMPORT);
  });

  it("names the testing rule in the message", async () => {
    const [result] = await eslint.lintText(HARNESS, { filePath: resolve(ROOT, "packages/server/src/fixture.ts") });
    expect(result?.messages.map((m) => m.message).join("\n")).toContain("@slugbase/db/testing");
  });

  it.each([
    "packages/server/src/fixture.test.ts",
    "packages/adapters/src/deep/fixture.spec.ts",
    "packages/server/test/helpers/fixture.ts",
    "apps/slugbase/test/fixture.ts",
    "apps/slugbase/scripts/fixture.ts",
    "packages/testing/src/fixture.ts",
  ])("passes in test code, app tooling and the testing package: %s", async (file) => {
    await passes(file, HARNESS);
  });

  it("still allows the public entry of db in production code", async () => {
    await passes("packages/server/src/fixture.ts", 'import "@slugbase/db";\n');
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

describe("suppressing the import-boundary and raw-I/O rules (T1, T6)", () => {
  const FETCH = 'void fetch("https://example.com");\n';
  const IMPORT_UNDICI = 'import { request } from "undici";\nvoid request;\n';
  const DB = 'import { drizzle } from "drizzle-orm/postgres-js";\nexport const db = drizzle({} as never);\n';
  const FILE = "packages/server/src/fixture.ts";

  it.each([
    ["a bare next-line directive", "// eslint-disable-next-line\n"],
    ["a next-line directive naming the rule", `// eslint-disable-next-line ${RAW_IO}\n`],
    ["a directive with a reason but no issue link", `// eslint-disable-next-line ${RAW_IO} -- it is fine\n`],
    ["a directive with only a reason", "// eslint-disable-next-line -- it is fine\n"],
    ["a blanket block directive", "/* eslint-disable */\n"],
    ["a block directive naming the rule", `/* eslint-disable ${RAW_IO} */\n`],
    ["a block directive with a reason", `/* eslint-disable ${RAW_IO} -- trusted */\n`],
    ["a block enable pair", `/* eslint-disable ${RAW_IO} */\n${FETCH}/* eslint-enable ${RAW_IO} */\n`],
    ["inline configuration switching the rule off", `/* eslint ${RAW_IO}: "off" */\n`],
    ["inline configuration with a reason", `/* eslint ${RAW_IO}: 0 -- trusted */\n`],
    ["inline configuration among other rules", `/*eslint\n  no-console: "off",\n  ${RAW_IO}: "off"\n*/\n`],
  ])("reports the global fetch under %s", async (_name, directive) => {
    await failsWith(FILE, `${directive}${FETCH}`, RAW_IO);
  });

  it("reports the global fetch under a same-line directive", async () => {
    await failsWith(FILE, `${FETCH.trimEnd()} // eslint-disable-line ${RAW_IO}\n`, RAW_IO);
    await failsWith(FILE, `${FETCH.trimEnd()} // eslint-disable-line\n`, RAW_IO);
  });

  it.each([
    ["a bare next-line directive", "// eslint-disable-next-line\n"],
    ["a next-line directive naming the rule", `// eslint-disable-next-line ${IMPORT} -- it is fine\n`],
    ["a blanket block directive", "/* eslint-disable */\n"],
    ["inline configuration switching the rule off", `/* eslint ${IMPORT}: "off" */\n`],
  ])("reports an HTTP client import under %s", async (_name, directive) => {
    await failsWith(FILE, `${directive}${IMPORT_UNDICI}`, IMPORT);
  });

  it("reports a database handle outside packages/db under a directive without an issue link", async () => {
    await failsWith(FILE, `// eslint-disable-next-line ${RAW_IO} -- it is fine\n${DB}`, RAW_IO);
  });

  it.each([
    ["next-line", `// eslint-disable-next-line ${RAW_IO} -- sanitised upstream, see #123\n${FETCH}`],
    ["next-line with an issue URL", `// eslint-disable-next-line ${RAW_IO} -- https://github.com/mdg-labs/slugbase/issues/123\n${FETCH}`],
    ["same-line", `${FETCH.trimEnd()} // eslint-disable-line ${RAW_IO} -- see #123\n`],
    ["file-wide", `/* eslint-disable ${RAW_IO} -- see #123 */\n${FETCH}`],
    ["blanket", `/* eslint-disable -- see #123 */\n${FETCH}`],
    ["inline configuration", `/* eslint ${RAW_IO}: "off" -- see #123 */\n${FETCH}`],
  ])("accepts a %s directive that carries an issue link", async (_name, code) => {
    await passes(FILE, code);
  });

  it("accepts an HTTP client import under a directive with an issue link", async () => {
    await passes(FILE, `// eslint-disable-next-line ${IMPORT} -- see #123\n${IMPORT_UNDICI}`);
    await passes(FILE, `/* eslint ${IMPORT}: "off" -- see #123 */\n${IMPORT_UNDICI}`);
  });

  it("leaves directives for other rules, and files outside packages and apps, alone", async () => {
    await passes(FILE, `// eslint-disable-next-line no-console -- see ${RAW_IO}\nexport {};\n`);
    await passes(FILE, '/* eslint no-console: "off" */\nexport {};\n');
    await passes("tooling/fixture.ts", `/* eslint ${RAW_IO}: "off" */\n${FETCH}`);
  });

  it("applies through eslint.config.js as `pnpm lint` runs it", { timeout: SUBPROCESS_TIMEOUT_MS }, async () => {
    expect(await ruleIds("packages/server/src/index.ts", `// eslint-disable-next-line ${RAW_IO}\n${FETCH}`, repoEslint)).toContain(RAW_IO);
    expect(await ruleIds("packages/server/src/index.ts", `/* eslint ${IMPORT}: "off" */\n${IMPORT_UNDICI}`, repoEslint)).toContain(IMPORT);
    expect(await ruleIds("packages/server/src/index.ts", `// eslint-disable-next-line ${RAW_IO} -- see #123\n${FETCH}`, repoEslint)).toEqual([]);
  });
});

describe("the repository lint ignores", { timeout: SUBPROCESS_TIMEOUT_MS }, () => {
  const ignored = (file: string): Promise<boolean> => repoEslint.isPathIgnored(resolve(ROOT, file));

  it.each([
    "packages/server/dist/index.js",
    "packages/web/dist/assets/app.js",
    "apps/slugbase/dist/main.js",
    "packages/core/coverage/lcov-report/index.js",
    "tooling/coverage/index.js",
    "e2e/dist/index.js",
    "dist/index.js",
    "coverage/index.js",
  ])("ignores build and coverage output at a package root: %s", async (file) => {
    expect(await ignored(file)).toBe(true);
  });

  it.each([
    "packages/server/src/dist/fixture.ts",
    "packages/server/src/coverage/fixture.ts",
    "packages/web/src/routes/dist/fixture.tsx",
    "apps/slugbase/src/dist/fixture.ts",
    "packages/server/test/coverage/fixture.ts",
  ])("lints a source folder named dist or coverage: %s", async (file) => {
    expect(await ignored(file)).toBe(false);
  });

  it("reports unused disable directives as errors", async () => {
    const config = (await repoEslint.calculateConfigForFile(resolve(ROOT, "packages/server/src/index.ts"))) as {
      linterOptions?: { reportUnusedDisableDirectives?: unknown };
    };
    expect(config.linterOptions?.reportUnusedDisableDirectives).toBe(2);
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

  // CLAUDE.md lists the files a plain text search finds, for the security audit.
  // The test reads each tracked file's syntax instead, so it fails on an outbound
  // request and not on a `fetch` method that serves requests in-process.
  it("sweep-raw-fetch finds no outbound request outside packages/adapters/src/egress/", () => {
    const listed = spawnSync("git", ["ls-files", "--", "packages/**/*.ts"], { cwd: ROOT, encoding: "utf8" });
    if (listed.status !== 0) {
      throw new Error(`git ls-files failed: ${listed.stderr}`);
    }
    const files = listed.stdout
      .split("\n")
      .filter((file) => file !== "" && !file.startsWith("packages/adapters/src/egress/"));
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.flatMap((file) =>
      findRawOutbound(readFileSync(resolve(ROOT, file), "utf8"), file).map((found) => `${file} ${found}`),
    );
    expect(offenders).toEqual([]);
  });

  // The list CLAUDE.md gives the security audit. It matches the text `fetch(` too, so outside the
  // egress adapter and the test files it may name only files whose syntax holds no outbound request.
  it("sweep-raw-fetch names only the egress adapter, test files and files with no outbound request", () => {
    const listed = sweep(["fetch(", "node:http", "undici"], "packages/**/*.ts");
    expect(listed).toContain("packages/adapters/src/egress/egress.ts");
    const isTest = (file: string): boolean => /(^|\/)test\//.test(file) || /\.test\.tsx?$/.test(file);
    const others = listed.filter((file) => !file.startsWith("packages/adapters/src/egress/") && !isTest(file));
    const offenders = others.flatMap((file) =>
      findRawOutbound(readFileSync(resolve(ROOT, file), "utf8"), file).map((found) => `${file} ${found}`),
    );
    expect(offenders).toEqual([]);
  });

  it("sweep-raw-db lists nothing outside packages/db", () => {
    const files = sweep(["drizzle(", "postgres("], "packages/**/*.ts");
    expect(files.filter((file) => !file.startsWith("packages/db/"))).toEqual([]);
  });

  it("sweep-html lists nothing", () => {
    expect(sweep(["dangerouslySetInnerHTML", "innerHTML"], "packages/**/*.tsx")).toEqual([]);
  });
});

describe("raw outbound matcher (T6)", () => {
  it.each([
    ["a bare call", 'void fetch("https://example.com");\n'],
    ["globalThis", 'void globalThis.fetch("https://example.com");\n'],
    ["window", 'void window.fetch("https://example.com");\n'],
    ["self", 'void self.fetch("https://example.com");\n'],
    ["global", 'void global.fetch("https://example.com");\n'],
    ["a string key", 'void globalThis["fetch"]("https://example.com");\n'],
    ["an asserted object", 'void (globalThis as typeof globalThis).fetch("https://example.com");\n'],
    ["an optional call", 'void globalThis.fetch?.("https://example.com");\n'],
    ["a call inside a class", 'class A {\n  run() {\n    return fetch("https://example.com");\n  }\n}\n'],
    ["a call beside a fetch method", 'class A {\n  fetch(request: Request) {\n    return globalThis.fetch(request);\n  }\n}\n'],
    ["an alias that is called", 'const send = fetch;\nvoid send("https://example.com");\n'],
    ["an alias of a member", "const send = globalThis.fetch;\nvoid send;\n"],
    ["an alias by string key", 'const send = window["fetch"];\nvoid send;\n'],
    ["an asserted alias", "const send = fetch as typeof globalThis.fetch;\nvoid send;\n"],
    ["a client handed fetch", "declare function client(options: object): void;\nclient({ fetch });\n"],
    ["a client handed fetch as an argument", "declare function client(send: unknown): void;\nclient(fetch);\n"],
    ...["node:http", "node:https", "http", "https", "undici"].flatMap((spec) => [
      [`import of ${spec}`, `import { request } from "${spec}";\nvoid request;\n`],
      [`namespace import of ${spec}`, `import * as lib from "${spec}";\nvoid lib;\n`],
      [`side-effect import of ${spec}`, `import "${spec}";\n`],
      [`type import of ${spec}`, `import type { Agent } from "${spec}";\nexport type A = Agent;\n`],
      [`re-export of ${spec}`, `export * from "${spec}";\n`],
      [`dynamic import of ${spec}`, `const lib = await import("${spec}");\nvoid lib;\n`],
      [`require of ${spec}`, `const lib = require("${spec}");\nvoid lib;\n`],
      [`import equals of ${spec}`, `import lib = require("${spec}");\nvoid lib;\n`],
    ]),
  ])("flags %s", (_name, code) => {
    expect(findRawOutbound(code)).not.toEqual([]);
  });

  it.each([
    ["a socket import", 'import { connect } from "node:net";\nvoid connect;\n'],
    ["a bare socket import", 'import { lookup } from "dns";\nvoid lookup;\n'],
    ["a tls require", 'const lib = require("node:tls");\nvoid lib;\n'],
    ["a dgram dynamic import", 'const lib = await import("node:dgram");\nvoid lib;\n'],
    ["a module import", 'import { createRequire } from "node:module";\nvoid createRequire;\n'],
    ["getBuiltinModule", 'void process.getBuiltinModule("node:net");\n'],
    ["getBuiltinModule by string key", 'void process["getBuiltinModule"];\n'],
    ["a destructured getBuiltinModule", "const { getBuiltinModule } = process;\nvoid getBuiltinModule;\n"],
    ["a WebSocket", 'void new WebSocket("wss://example.com");\n'],
    ["a WebSocket through globalThis", 'void new globalThis.WebSocket("wss://example.com");\n'],
    ["an EventSource alias", "const Source = EventSource;\nvoid Source;\n"],
    ["a third-party client", 'import axios from "axios";\nvoid axios;\n'],
  ])("flags %s", (_name, code) => {
    expect(findRawOutbound(code, "packages/server/src/fixture.ts")).not.toEqual([]);
  });

  it.each([
    ["the egress folder", "packages/adapters/src/egress/fixture.ts"],
    ["a test folder", "packages/server/test/fixture.ts"],
    ["a test file", "packages/server/src/fixture.test.ts"],
    ["an app script", "apps/slugbase/scripts/fixture.ts"],
  ])("allows socket forms in %s", (_name, file) => {
    expect(
      findRawOutbound('import { connect } from "node:net";\nvoid connect;\nvoid process.getBuiltinModule("node:net");\nvoid new WebSocket("x");\n', file),
    ).toEqual([]);
  });

  it("allows the listed exemptions only for their module", () => {
    expect(findRawOutbound('import { isIP } from "node:net";\nvoid isIP;\n', "packages/server/src/http/trusted-proxy.ts")).toEqual([]);
    expect(findRawOutbound('import "node:dns";\n', "packages/server/src/http/trusted-proxy.ts")).not.toEqual([]);
    expect(findRawOutbound('import { createRequire } from "node:module";\nvoid createRequire;\n', "packages/server/src/migrate/pgboss.ts")).toEqual([]);
    expect(findRawOutbound('import "node:net";\n', "packages/server/src/migrate/pgboss.ts")).not.toEqual([]);
  });

  it.each([
    ["a member call on an app", "export function run(app: { fetch(r: Request): Promise<Response> }, r: Request) {\n  return app.fetch(r);\n}\n"],
    ["a member call on a server", "declare const server: { fetch(r: Request): Promise<Response> };\nvoid server.fetch(new Request('http://localhost/'));\n"],
    ["an awaited member call", "declare const app: { fetch(r: Request, env: object): Promise<Response> };\nexport const go = async (r: Request) => await app.fetch(r, {});\n"],
    ["a method signature", "export interface Server {\n  fetch(request: Request): Promise<Response>;\n}\n"],
    ["a method declaration", "export class Server {\n  fetch(request: Request): Promise<Response> {\n    return Promise.resolve(new Response());\n  }\n}\n"],
    ["an object method", "export const server = {\n  fetch(request: Request) {\n    return Promise.resolve(new Response());\n  },\n};\n"],
    ["a property", "export const server = { fetch: async (request: Request) => new Response() };\n"],
    ["the word in a comment and a string", '// fetch(url) and import "undici"\nexport const text = "fetch( node:http undici";\n'],
    ["a non-HTTP module", 'import { createHash } from "node:crypto";\nvoid createHash;\n'],
    ["the type of fetch", "export type Send = typeof fetch;\nexport type Member = typeof globalThis.fetch;\n"],
    ["a destructured member of another object", "declare const options: { fetch: () => void };\nconst { fetch: send } = options;\nvoid send;\n"],
  ])("does not flag %s", (_name, code) => {
    expect(findRawOutbound(code)).toEqual([]);
  });
});
