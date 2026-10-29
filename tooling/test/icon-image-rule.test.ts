import { ESLint, type Linter } from "eslint";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";
import { ROOT } from "./run.ts";

const { componentLibraryRules, iconImageRules } = (await import(pathToFileURL(resolve(ROOT, "eslint.config.js")).href)) as {
  componentLibraryRules: Linter.Config;
  iconImageRules: Linter.Config;
};

// The two blocks in the order the repository's config lists them, with the TypeScript parser only, so the check does not depend on the type-aware project.
const eslint = new ESLint({
  cwd: ROOT,
  overrideConfigFile: true,
  overrideConfig: [{ files: ["**/*.{ts,tsx}"], languageOptions: { parser: tseslint.parser } }, componentLibraryRules, iconImageRules],
});

const WEB = "packages/web/src/bookmarks/example.tsx";
const UI = "packages/ui/src/patterns/example.tsx";

async function restrictedSyntax(source: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(source, { filePath: resolve(ROOT, filePath) });
  return (result?.messages ?? []).filter((m) => m.ruleId === "no-restricted-syntax").map((m) => m.message);
}

describe("the Favicon pattern is the only place an icon image is created (doc 03 Component system, doc 10 T14)", () => {
  it.each([
    ['export const a = <img alt="" src="/api/v1/favicons/example.com" />;'],
    ['export const a = <img alt="" src="https://example.com/favicon.ico" />;'],
    ['export const a = <IMG alt="" src={url} />;'],
    ['export const a = <picture><source srcSet={url} /></picture>;'],
    ["export const a = <svg><image href={url} /></svg>;"],
    ['export const a = document.createElement("img");'],
    ['export const a = document.createElement("IMG");'],
    ["export const a = document.createElement(`img`);"],
    ['export const a = createElement("img", { src: url });'],
    ['export const a = React.createElement("img", { src: url });'],
    ["export const a = new Image();"],
    ["export const a = new window.Image();"],
    ["export const a = new globalThis.Image();"],
  ])("rejects %s in the web app and in @slugbase/ui", async (source) => {
    for (const file of [WEB, UI]) {
      const messages = await restrictedSyntax(source, file);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain("Favicon pattern");
    }
  });

  it("allows the pattern itself and the QR code of the two-factor enrolment", async () => {
    const source = 'export const a = <img alt="" src="/api/v1/favicons/example.com" />;';
    expect(await restrictedSyntax(source, "packages/ui/src/patterns/favicon.tsx")).toEqual([]);
    expect(await restrictedSyntax(source, "packages/web/src/account/mfa-enrollment.tsx")).toEqual([]);
  });

  it("allows other elements, other calls and the component that draws the icon", async () => {
    const source = [
      'import { Favicon } from "@slugbase/ui/patterns";',
      'export const a = <span><Favicon host="example.com" /></span>;',
      'export const b = document.createElement("div");',
      'export const c = document.querySelector("img");',
      'export const d = t("image");',
      "export const e = new Date();",
    ].join("\n");
    expect(await restrictedSyntax(source, WEB)).toEqual([]);
  });

  it("keeps the process.env ban for the same files, which this block repeats", async () => {
    const messages = await restrictedSyntax("export const v = process.env.HOME;", WEB);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("process.env");
  });

  it("leaves test files and other packages alone", async () => {
    const source = 'export const a = <img alt="" src="x" />;';
    expect(await restrictedSyntax(source, "packages/web/test/example.tsx")).toEqual([]);
    expect(await restrictedSyntax(source, "packages/email/src/example.tsx")).toEqual([]);
  });
});
