import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../vitest.shared.ts";

interface Manifest {
  name: string;
  exports: Record<string, unknown>;
}

const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as Manifest;

describe("@slugbase/contracts", () => {
  it("exposes only its declared entry points", () => {
    expect(manifest.name).toBe("@slugbase/contracts");
    expect(Object.keys(manifest.exports)).toEqual(["."]);
  });

  it("loads src/index.ts", { timeout: HEAVY_TEST_TIMEOUT_MS }, async () => {
    await expect(import("../src/index.ts")).resolves.toBeTypeOf("object");
  });
});
