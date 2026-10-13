import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface Manifest {
  name: string;
  exports: Record<string, unknown>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as Manifest;

describe("@slugbase/testing-ports", () => {
  it("exposes only its declared entry points", () => {
    expect(manifest.name).toBe("@slugbase/testing-ports");
    expect(Object.keys(manifest.exports)).toEqual(["."]);
  });

  // @slugbase/core takes this package as a devDependency, so any edge back to a
  // workspace package would bring the package cycle back (doc 09 section 2.1).
  it("declares no workspace package in any dependency field", () => {
    const declared = [
      manifest.dependencies,
      manifest.devDependencies,
      manifest.peerDependencies,
      manifest.optionalDependencies,
    ].flatMap((field) => Object.keys(field ?? {}));
    expect(declared.filter((name) => name.startsWith("@slugbase/"))).toEqual([]);
  });

  it("loads src/index.ts", async () => {
    await expect(import("../src/index.ts")).resolves.toBeTypeOf("object");
  });
});
