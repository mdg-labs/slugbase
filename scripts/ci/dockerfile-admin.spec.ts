import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ADMIN_DOCKERFILE = resolve(
  import.meta.dirname,
  "../../packages/admin/Dockerfile",
);

describe("admin Dockerfile workspace deps", () => {
  const dockerfile = readFileSync(ADMIN_DOCKERFILE, "utf8");

  it("installs shared-types workspace package for admin server build", () => {
    expect(dockerfile).toMatch(/COPY packages\/shared-types\/package\.json packages\/shared-types\//);
    expect(dockerfile).toMatch(/COPY packages\/shared-types packages\/shared-types/);
  });

  it("installs ui workspace package for admin Vite font styles", () => {
    expect(dockerfile).toMatch(/COPY packages\/ui\/package\.json packages\/ui\//);
    expect(dockerfile).toMatch(/COPY packages\/ui packages\/ui/);
  });
});
