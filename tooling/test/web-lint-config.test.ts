import { resolve } from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
import { ROOT, SUBPROCESS_TIMEOUT_MS } from "./run.ts";

// The probes go through packages/web/eslint.config.js as `eslint` finds it when
// the package lints itself (`turbo run lint` runs there): an instance whose cwd
// is the package, with no overrideConfigFile. A probe borrows the path of a
// source file that exists, because the type-aware rules resolve a file through
// the package's tsconfig, and replaces its text.
const WEB = resolve(ROOT, "packages/web");
const TS_PROBE_PATH = resolve(WEB, "src/zod-jitless.ts");
const TSX_PROBE_PATH = resolve(WEB, "src/bookmarks/bookmark-card.tsx");

const eslint = new ESLint({ cwd: WEB });

async function errorRules(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  if (result === undefined) {
    throw new Error(`no lint result for ${filePath}`);
  }
  return result.messages.filter((m) => m.severity === 2).map((m) => m.ruleId ?? "parse-error");
}

async function syntaxMessages(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  if (result === undefined) {
    throw new Error(`no lint result for ${filePath}`);
  }
  return result.messages.filter((m) => m.ruleId === "no-restricted-syntax").map((m) => m.message);
}

describe("packages/web/eslint.config.js", () => {
  it(
    "rejects a process.env read in the web sources",
    async () => {
      const rules = await errorRules("export const value = process.env.EXAMPLE;\n", TS_PROBE_PATH);
      expect(rules).toContain("no-restricted-syntax");
    },
    SUBPROCESS_TIMEOUT_MS,
  );

  it(
    "rejects an import of a second component library in the web sources",
    async () => {
      const rules = await errorRules('import { Dialog } from "@radix-ui/react-dialog";\nexport const value = Dialog;\n', TS_PROBE_PATH);
      expect(rules).toContain("no-restricted-imports");
    },
    SUBPROCESS_TIMEOUT_MS,
  );

  it(
    "rejects a dynamic import of a second component library in the web sources",
    async () => {
      const rules = await errorRules('export const load = () => import("sonner");\n', TS_PROBE_PATH);
      expect(rules).toContain("no-restricted-syntax");
    },
    SUBPROCESS_TIMEOUT_MS,
  );

  it(
    "rejects a raw outbound request in the web sources",
    async () => {
      const rules = await errorRules('export const load = () => fetch("/api");\n', TS_PROBE_PATH);
      expect(rules).toContain("slugbase/no-raw-io");
    },
    SUBPROCESS_TIMEOUT_MS,
  );

  it(
    "rejects a literal string in the JSX of the web sources",
    async () => {
      const rules = await errorRules(
        'export function Probe(): React.ReactElement { return <span className="x">Hello there</span>; }\n',
        TSX_PROBE_PATH,
      );
      expect(rules).toContain("i18next/no-literal-string");
    },
    SUBPROCESS_TIMEOUT_MS,
  );

  it(
    "rejects an icon image element outside the Favicon pattern in the web sources",
    async () => {
      for (const code of [
        'export const a = <img alt="" src="https://x.example/f.ico" />;\n',
        'export const a = document.createElement("img");\n',
        "export const a = new Image();\n",
      ]) {
        const messages = await syntaxMessages(code, TSX_PROBE_PATH);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toContain("Favicon pattern");
      }
    },
    SUBPROCESS_TIMEOUT_MS,
  );

  it(
    "allows the image of the two-factor enrolment, which draws no icon",
    async () => {
      const messages = await syntaxMessages('export const a = <img alt="" src={qr} />;\n', resolve(WEB, "src/account/mfa-enrollment.tsx"));
      expect(messages).toEqual([]);
    },
    SUBPROCESS_TIMEOUT_MS,
  );

  it(
    "keeps the process.env and second-library selectors beside the icon image selectors",
    async () => {
      const env = await syntaxMessages("export const value = process.env.EXAMPLE;\n", TS_PROBE_PATH);
      expect(env).toHaveLength(1);
      expect(env[0]).toContain("process.env");
      const library = await syntaxMessages('export const load = () => import("sonner");\n', TS_PROBE_PATH);
      expect(library).toHaveLength(1);
      expect(library[0]).not.toContain("Favicon pattern");
    },
    SUBPROCESS_TIMEOUT_MS,
  );

  it(
    "keeps the generated route tree out of the lint run",
    async () => {
      expect(await eslint.isPathIgnored(resolve(WEB, "src/routeTree.gen.ts"))).toBe(true);
      expect(await eslint.isPathIgnored(TS_PROBE_PATH)).toBe(false);
    },
    SUBPROCESS_TIMEOUT_MS,
  );
});
