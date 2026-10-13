import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface Manifest {
  name: string;
  exports: Record<string, unknown>;
}

const manifest = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8"),
) as Manifest;

describe("@slugbase/ui", () => {
  it("exposes only its declared entry points", () => {
    expect(manifest.name).toBe("@slugbase/ui");
    expect(Object.keys(manifest.exports)).toEqual([".", "./patterns", "./styles/theme.css"]);
  });

  it("loads src/index.ts", async () => {
    await expect(import("../src/index.ts")).resolves.toBeTypeOf("object");
  });
});
