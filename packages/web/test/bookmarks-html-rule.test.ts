import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../vitest.shared.ts";

// Bookmark text reaches the page only as text (doc 10 T14). Two checks keep the components that show it that way: the
// sweep of CLAUDE.md finds no file that can write HTML, and the lint task of this package, which loads this package's
// own eslint.config.js, fails on a component that does. The rule itself (slugbase/no-unsafe-html) is declared once in the
// shared configuration; these tests prove this package's configuration applies it to the bookmark components.

const WEB = resolve(import.meta.dirname, "..");
const REPO = resolve(WEB, "../..");

const eslint = new ESLint({ cwd: WEB });

// The rule reads string literals too, so the names it bans are put together here and this file passes the rule it tests.
const SET_INNER = ["dangerously", "SetInner", "HTML"].join("");
const INNER = ["inner", "HTML"].join("");

async function ruleIds(file: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: resolve(WEB, file) });
  if (result === undefined) {
    throw new Error(`no lint result for ${file}`);
  }
  return result.messages.filter((message) => message.severity === 2).map((message) => message.ruleId ?? `parse-error: ${message.message}`);
}

describe("unsanitised HTML in the bookmark components", () => {
  it("is found by no file of the sweep in packages/web", () => {
    const found = spawnSync("git", ["grep", "-l", "--untracked", "-e", SET_INNER, "-e", INNER, "--", "packages/web/**/*.tsx"], {
      cwd: REPO,
      encoding: "utf8",
    });
    // git grep exits 1 for "no match" and above that for a failure.
    expect(found.status, found.stderr).toBe(1);
    expect(found.stdout).toBe("");
  });

  it.each([
    ["the React property", `export const Title = ({ title }: { title: string }) => <span ${SET_INNER}={{ __html: title }} />;\n`],
    ["the DOM property", `export function show(element: HTMLElement, title: string): void {\n  element.${INNER} = title;\n}\n`],
    ["the DOM property by a quoted name", `export function show(element: HTMLElement, title: string): void {\n  element["${INNER}"] = title;\n}\n`],
  ])("fails a bookmark component that uses %s", { timeout: HEAVY_TEST_TIMEOUT_MS }, async (_name, code) => {
    expect(await ruleIds("src/bookmarks/bookmark-card.tsx", code)).toContain("slugbase/no-unsafe-html");
  });

  it("passes the bookmark card as it is", { timeout: HEAVY_TEST_TIMEOUT_MS }, async () => {
    const source = readFileSync(resolve(WEB, "src/bookmarks/bookmark-card.tsx"), "utf8");
    expect(await ruleIds("src/bookmarks/bookmark-card.tsx", source)).toEqual([]);
  });
});
