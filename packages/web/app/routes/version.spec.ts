import { describe, expect, it } from "vitest";

import { loader } from "./version.js";

describe("GET /version loader", () => {
  it("returns package version as JSON", async () => {
    const response = loader({} as Parameters<typeof loader>[0]);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { version: string };
    expect(body.version).toBe("0.0.0");
  });
});
