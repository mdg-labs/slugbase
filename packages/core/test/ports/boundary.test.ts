import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PORTS = join(import.meta.dirname, "../../src/ports");

// The interfaces carry no adapter type and core has no I/O: a file of the
// ports imports a sibling or @slugbase/contracts, nothing else.
describe("src/ports imports", () => {
  const files = readdirSync(PORTS).filter((name) => name.endsWith(".ts"));

  it("finds the port files", () => {
    expect(files.length).toBeGreaterThanOrEqual(13);
  });

  it.each(files)("%s imports only siblings and @slugbase/contracts", (file) => {
    const source = readFileSync(join(PORTS, file), "utf8");
    const specifiers = [...source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((match) => match[1]);
    for (const specifier of specifiers) {
      expect(specifier === "@slugbase/contracts" || specifier?.startsWith("./"), `${file} imports ${String(specifier)}`).toBe(true);
    }
  });
});
