import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";
import { ROOT } from "./run.ts";

interface NodeVersionModule {
  isSupportedNode: (version: string) => boolean;
  REQUIRED_RANGE: string;
}

// The module is plain JavaScript that `preinstall` runs before any dependency
// exists, so it has no declaration file; a computed specifier keeps tsc from
// resolving it.
const specifier = pathToFileURL(resolve(ROOT, "scripts/node-version.mjs")).href;
const { isSupportedNode, REQUIRED_RANGE } = (await import(specifier)) as NodeVersionModule;

describe("Node.js version floor", () => {
  it.each(["24.2.0", "24.2.1", "24.21.0", "24.99.99"])("accepts %s", (version) => {
    expect(isSupportedNode(version)).toBe(true);
  });

  it.each(["24.0.0", "24.1.0", "24.1.9", "23.11.0", "22.20.0", "25.0.0", "26.3.0"])(
    "refuses %s",
    (version) => {
      expect(isSupportedNode(version)).toBe(false);
    },
  );

  it("agrees with the package.json engines range", () => {
    const manifest = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
      engines: { node: string };
    };
    expect(manifest.engines.node).toBe(REQUIRED_RANGE);
  });
});
