import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { applySecurityHeaders } from "./apply-security-headers.js";

const mainTsPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../main.ts",
);

describe("applySecurityHeaders", () => {
  it("registers helmet middleware on the Nest Express instance", () => {
    const use = vi.fn();
    const app = { use } as unknown as Parameters<typeof applySecurityHeaders>[0];

    applySecurityHeaders(app, { enableHsts: false });

    expect(use).toHaveBeenCalledTimes(1);
    expect(typeof use.mock.calls[0]?.[0]).toBe("function");
  });

  it("main.ts applies security headers before the self-hosted web client mount", async () => {
    const mainSource = await readFile(mainTsPath, "utf8");

    const securityIndex = mainSource.indexOf("applySecurityHeaders(app");
    const webClientIndex = mainSource.indexOf("registerWebClientMiddleware");

    expect(securityIndex).toBeGreaterThan(-1);
    expect(webClientIndex).toBeGreaterThan(-1);
    expect(securityIndex).toBeLessThan(webClientIndex);
  });
});
