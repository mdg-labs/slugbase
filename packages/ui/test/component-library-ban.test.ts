import { ESLint, type Linter } from "eslint";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../../..");

const { componentLibraryRules } = (await import(pathToFileURL(resolve(ROOT, "eslint.config.js")).href)) as {
  componentLibraryRules: Linter.Config;
};

// Lints text with the shared component-library block and the TypeScript parser only,
// so the check does not depend on the type-aware project setup of the full config.
const eslint = new ESLint({
  cwd: ROOT,
  overrideConfigFile: true,
  overrideConfig: [{ files: ["**/*.{ts,tsx}"], languageOptions: { parser: tseslint.parser } }, componentLibraryRules],
});

async function restrictedImports(source: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(source, { filePath: resolve(ROOT, filePath) });
  return (result?.messages ?? []).filter((m) => m.ruleId === "no-restricted-imports").map((m) => m.message);
}

async function restrictedSyntax(source: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(source, { filePath: resolve(ROOT, filePath) });
  return (result?.messages ?? []).filter((m) => m.ruleId === "no-restricted-syntax").map((m) => m.message);
}

describe("second component library ban", () => {
  it.each([
    ['import { Dialog } from "@radix-ui/react-dialog";'],
    ['import * as Select from "@radix-ui/react-select";'],
    ['import { Command } from "cmdk";'],
    ['import { Button } from "@mui/material";'],
    ['import { toast } from "sonner";'],
    ['import { Popover } from "@headlessui/react";'],
  ])("rejects %s in @slugbase/ui", async (source) => {
    const messages = await restrictedImports(source, "packages/ui/src/components/thing.tsx");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("only component library");
  });

  it("rejects a second library in @slugbase/web too", async () => {
    const messages = await restrictedImports('import { Command } from "cmdk";', "packages/web/src/routes/index.tsx");
    expect(messages).toHaveLength(1);
  });

  it.each([
    ['const mod = import("cmdk");'],
    ['const mod = import("sonner");'],
    ['const mod = import("@radix-ui/react-dialog");'],
    ['const mod = import("react-aria-components/Button");'],
    ["const mod = import(`vaul`);"],
  ])("rejects the dynamic form %s", async (source) => {
    for (const file of ["packages/ui/src/components/thing.tsx", "packages/web/src/routes/index.tsx"]) {
      const messages = await restrictedSyntax(source, file);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain("only component library");
    }
  });

  it("allows a dynamic import of Base UI, lucide-react and a package that only shares a prefix", async () => {
    const source = [
      'const a = import("@base-ui/react/dialog");',
      'const b = import("lucide-react");',
      'const c = import("sonner-not-a-library");',
      "const d = import(`./thing.tsx`);",
    ].join("\n");
    expect(await restrictedSyntax(source, "packages/ui/src/components/thing.tsx")).toEqual([]);
  });

  it("allows Base UI, lucide-react and the ui package's own helpers", async () => {
    const source = [
      'import { Dialog } from "@base-ui/react/dialog";',
      'import { SearchIcon } from "lucide-react";',
      'import { cn } from "../lib/utils.ts";',
    ].join("\n");
    expect(await restrictedImports(source, "packages/ui/src/components/thing.tsx")).toEqual([]);
  });

  it("keeps the process import ban for the same files", async () => {
    const messages = await restrictedImports('import process from "node:process";', "packages/ui/src/x.ts");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("process.env");
  });

  it("keeps the process.env syntax ban for the same files", async () => {
    const messages = await restrictedSyntax("export const v = process.env.HOME;", "packages/web/src/x.ts");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("process.env");
  });
});
