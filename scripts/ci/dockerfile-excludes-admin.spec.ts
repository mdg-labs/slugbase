import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const CE_DOCKERFILES = [
  "Dockerfile.api",
  "Dockerfile.web",
  "Dockerfile.legacy",
] as const;

function readDockerfile(name: (typeof CE_DOCKERFILES)[number]): string {
  return readFileSync(resolve(REPO_ROOT, name), "utf8");
}

describe.each(CE_DOCKERFILES)("CE Dockerfile %s excludes admin packages", (name) => {
  const dockerfile = readDockerfile(name);

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
