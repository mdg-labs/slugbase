import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const WEB = resolve(import.meta.dirname, "..");

describe("the generated route tree", () => {
  it("is what the generator makes from the files under src/routes", () => {
    const scratch = mkdtempSync(join(tmpdir(), "slugbase-route-tree-"));
    try {
      cpSync(join(WEB, "src", "routes"), join(scratch, "routes"), { recursive: true });
      writeFileSync(
        join(scratch, "tsr.config.json"),
        readFileSync(join(WEB, "tsr.config.json"), "utf8").replace("./src/routes", "./routes").replace("./src/routeTree.gen.ts", "./routeTree.gen.ts"),
      );
      execFileSync(join(WEB, "node_modules", ".bin", "tsr"), ["generate"], { cwd: scratch, stdio: "pipe" });
      expect(readFileSync(join(scratch, "routeTree.gen.ts"), "utf8")).toBe(
        readFileSync(join(WEB, "src", "routeTree.gen.ts"), "utf8"),
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
