import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(__dirname, "..");
const scriptPath = join(repoRoot, ".github/scripts/build-push-ghcr.sh");
const sharedArgsPath = join(repoRoot, "scripts/self-host-vite-build-args.sh");

describe("build-push-ghcr.sh", () => {
  const script = readFileSync(scriptPath, "utf-8");
  const sharedArgs = readFileSync(sharedArgsPath, "utf-8");

  it("requires --target api or web", () => {
    expect(script).toContain('--target api|web');
    expect(script).toContain("Dockerfile.api");
    expect(script).toContain("Dockerfile.web");
  });

  it("uses self-host vite build-args only for the web target", () => {
    expect(script).toContain("self-host-vite-build-args.sh");
    expect(script).toContain("SELF_HOST_VITE_BUILD_ARGS");
    expect(script).not.toMatch(/env \| grep '\^VITE_'/);
    expect(script).not.toMatch(/VITE_SENTRY_/);

    expect(sharedArgs).toContain("SLUGBASE_EDITION=ce");
    expect(sharedArgs).not.toContain("VITE_BILLING_ENABLED=");
    expect(sharedArgs).not.toMatch(/VITE_SENTRY_/);
    expect(sharedArgs).not.toContain("${!key");
  });

  it("passes CE edition build-arg for the API target", () => {
    expect(script).toContain("--build-arg SLUGBASE_EDITION=ce");
  });
});
