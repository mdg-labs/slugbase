import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const scriptPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "cloud-registry-image.sh",
);

function run(service: string, registry = "berth.mdg-labs.dev") {
  return execFileSync("bash", [scriptPath, service], {
    encoding: "utf8",
    env: { ...process.env, REGISTRY: registry },
  }).trim();
}

describe("cloud-registry-image.sh", () => {
  it("builds slugbase-cloud paths for each surface", () => {
    expect(run("api")).toBe("berth.mdg-labs.dev/slugbase-cloud/api");
    expect(run("web")).toBe("berth.mdg-labs.dev/slugbase-cloud/web");
    expect(run("marketing")).toBe("berth.mdg-labs.dev/slugbase-cloud/marketing");
    expect(run("admin")).toBe("berth.mdg-labs.dev/slugbase-cloud/admin");
  });

  it("strips a trailing slash from REGISTRY", () => {
    expect(run("api", "berth.mdg-labs.dev/")).toBe(
      "berth.mdg-labs.dev/slugbase-cloud/api",
    );
  });
});
