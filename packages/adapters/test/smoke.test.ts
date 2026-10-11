import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface Manifest {
  name: string;
  exports: Record<string, unknown>;
}

const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as Manifest;

describe("@slugbase/adapters", () => {
  it("exposes only its declared entry points", () => {
    expect(manifest.name).toBe("@slugbase/adapters");
    expect(Object.keys(manifest.exports)).toEqual(["."]);
  });

  it("loads src/index.ts", async () => {
    await expect(import("../src/index.ts")).resolves.toBeTypeOf("object");
  });
});
