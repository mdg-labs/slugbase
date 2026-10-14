import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// What the image must hold on to (doc 01 section 1, doc 10 T16), read from the
// Dockerfile itself: the build of the image runs in CI, these checks run in the gate.

const APP = resolve(import.meta.dirname, "..");
const dockerfile = readFileSync(resolve(APP, "Dockerfile"), "utf8");
const dockerignore = readFileSync(resolve(APP, "../../.dockerignore"), "utf8");

const instructions = dockerfile
  .replace(/\\\n/g, " ")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line !== "" && !line.startsWith("#"));

function stages(): { from: string; body: string[] }[] {
  const result: { from: string; body: string[] }[] = [];
  for (const line of instructions) {
    if (line.startsWith("FROM ")) {
      result.push({ from: line, body: [] });
    } else {
      result.at(-1)?.body.push(line);
    }
  }
  return result;
}

describe("the Dockerfile", () => {
  it("pins every base image by digest, to the same one", () => {
    const bases = stages()
      .map(({ from }) => from)
      .filter((from) => !/^FROM \w+ AS /.test(from));
    expect(bases.length).toBeGreaterThanOrEqual(2);
    const digests = new Set(bases.map((from) => /^FROM node:24-slim@(sha256:[0-9a-f]{64}) AS /.exec(from)?.[1]));
    expect(digests.size).toBe(1);
    expect(digests.has(undefined)).toBe(false);
  });

  it("installs from the frozen lockfile", () => {
    expect(instructions.filter((line) => /pnpm install/.test(line)).every((line) => line.includes("--frozen-lockfile"))).toBe(true);
  });

  it("ends in a runtime stage that runs as a numeric non-root user through the entrypoint", () => {
    const runtime = stages().at(-1);
    expect(runtime?.from).toMatch(/ AS runtime$/);
    const users = runtime?.body.filter((line) => line.startsWith("USER ")) ?? [];
    expect(users).toHaveLength(1);
    expect(users[0]).toMatch(/^USER ([1-9]\d*):([1-9]\d*)$/);
    expect(runtime?.body).toContain('ENTRYPOINT ["/app/apps/slugbase/docker-entrypoint.sh"]');
    expect(runtime?.body).toContain('CMD ["server"]');
  });

  it("copies only built output into the runtime stage", () => {
    const runtime = stages().at(-1);
    const copied = (runtime?.body ?? []).filter((line) => line.startsWith("COPY "));
    expect(copied.length).toBeGreaterThan(0);
    expect(copied.every((line) => line.includes("--from=build "))).toBe(true);
    expect(copied.some((line) => /\/src\b|\/test\b|\.env|\.git/.test(line))).toBe(false);
  });

  it("ships the OpenAPI document the server checks its routes against", () => {
    expect(dockerfile).toContain("COPY --from=build /app/packages/contracts/generated/openapi.json ./packages/contracts/generated/openapi.json");
  });

  it("keeps the build revision out of the environment of the running container", () => {
    expect(instructions.filter((line) => /^ENV\b/.test(line) && /BUILD_COMMIT|VERSION|DATABASE/.test(line))).toEqual([]);
    const runtime = stages().at(-1);
    expect(runtime?.body.some((line) => /^ARG BUILD_COMMIT\b/.test(line))).toBe(true);
  });

  it("labels the source, the licence, the version and the revision", () => {
    for (const label of ["source", "licenses", "version", "revision"]) {
      expect(dockerfile).toContain(`org.opencontainers.image.${label}=`);
    }
    expect(dockerfile).toContain('org.opencontainers.image.licenses="AGPL-3.0-only"');
  });
});

describe(".dockerignore", () => {
  it.each([".git", ".env", ".env.*", "**/node_modules", "**/dist", "**/test"])("excludes %s", (pattern) => {
    expect(dockerignore.split("\n")).toContain(pattern);
  });
});
