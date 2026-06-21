import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const CE_DOCKERFILE = resolve(REPO_ROOT, "Dockerfile");

describe("CE Dockerfile excludes admin packages", () => {
  const dockerfile = readFileSync(CE_DOCKERFILE, "utf8");

  it("does not COPY packages/admin", () => {
    expect(dockerfile).not.toMatch(/COPY[^\n]*packages\/admin/);
  });

  it("does not COPY packages/db-admin", () => {
    expect(dockerfile).not.toMatch(/COPY[^\n]*packages\/db-admin/);
  });

  it("does not build admin packages in turbo filter", () => {
    expect(dockerfile).not.toMatch(/@slugbase\/admin/);
    expect(dockerfile).not.toMatch(/db-admin/);
  });
});
