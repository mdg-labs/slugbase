import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface Manifest {
  exports: Record<string, unknown>;
}

const ENTRY_POINTS: Record<string, string[]> = {
  contracts: ["."],
  core: ["."],
  db: ["."],
  server: ["."],
  adapters: ["."],
  email: ["."],
  ui: ["."],
  web: ["."],
  testing: [".", "./db", "./msw", "./tenancy"],
};

const DEEP_PATHS = [
  "src/index",
  "src/index.ts",
  "src/create-server",
  "dist/index.js",
  "dist/index.d.ts",
  "package.json",
];

function specifier(name: string, entry: string): string {
  return entry === "." ? `@slugbase/${name}` : `@slugbase/${name}/${entry.slice(2)}`;
}

describe.each(Object.entries(ENTRY_POINTS))("@slugbase/%s", (name, entries) => {
  it("declares exactly its entry points in the exports map", () => {
    const manifest = JSON.parse(
      readFileSync(new URL(`../../../packages/${name}/package.json`, import.meta.url), "utf8"),
    ) as Manifest;
    expect(Object.keys(manifest.exports)).toEqual(entries);
  });

  it.each(entries)("resolves the %s entry point to a built file", (entry) => {
    const resolved = import.meta.resolve(specifier(name, entry));
    expect(resolved).toMatch(/\/dist\/[a-z]+\.js$/);
    expect(existsSync(fileURLToPath(resolved))).toBe(true);
  });

  it.each(DEEP_PATHS)("does not resolve the deep path %s", (path) => {
    expect(() => import.meta.resolve(`@slugbase/${name}/${path}`)).toThrow(
      /not (defined by|exported)/i,
    );
  });
});
