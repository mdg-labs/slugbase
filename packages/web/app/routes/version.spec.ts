import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { loader } from "./version.js";

const webPackageVersion = (
  JSON.parse(
    readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../package.json"),
      "utf8",
    ),
  ) as { version: string }
).version;

describe("GET /version loader", () => {
  it("returns package version as JSON", async () => {
    const response = loader({} as Parameters<typeof loader>[0]);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { version: string };
    expect(body.version).toBe(webPackageVersion);
  });
});
