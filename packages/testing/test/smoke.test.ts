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

describe("@slugbase/testing", () => {
  it("exposes only its declared entry points", () => {
    expect(manifest.name).toBe("@slugbase/testing");
    expect(Object.keys(manifest.exports)).toEqual([".", "./db", "./msw", "./msw/node", "./tenancy"]);
  });

  it("loads src/index.ts", { timeout: HEAVY_TEST_TIMEOUT_MS }, async () => {
    await expect(import("../src/index.ts")).resolves.toBeTypeOf("object");
  });

  it("loads src/db.ts", { timeout: HEAVY_TEST_TIMEOUT_MS }, async () => {
    await expect(import("../src/db.ts")).resolves.toBeTypeOf("object");
  });

  it("loads src/msw.ts", { timeout: HEAVY_TEST_TIMEOUT_MS }, async () => {
    await expect(import("../src/msw.ts")).resolves.toBeTypeOf("object");
  });

  it("loads src/tenancy.ts", { timeout: HEAVY_TEST_TIMEOUT_MS }, async () => {
    await expect(import("../src/tenancy.ts")).resolves.toBeTypeOf("object");
  });
});
