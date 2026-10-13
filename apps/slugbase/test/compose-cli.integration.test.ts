import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  APP_PASSWORD,
  COMPOSE_FILE,
  hasDockerCompose,
  MIGRATOR_PASSWORD,
  OPERATOR_VALUES,
  operatorEnv,
  SUPERUSER_PASSWORD,
} from "./compose-support.ts";

// These cases need Docker Compose itself: that it accepts compose.yml with an
// environment made from .env.example plus generated secrets, and what it prints
// when a required key is missing. They run wherever the docker CLI is present;
// the CI build job, which has it, runs them. The structure of the stack, which
// needs no CLI, is checked in compose.integration.test.ts. `compose config`
// needs no daemon.

let directory: string;

function writeEnv(entries: ReadonlyMap<string, string>): string {
  const file = join(directory, `env-${String(Math.random()).slice(2)}`);
  writeFileSync(file, [...entries].map(([key, value]) => `${key}=${value}`).join("\n") + "\n");
  return file;
}

function compose(file: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("docker", ["compose", "--project-name", "slugbase-compose-test", "--env-file", file, "-f", COMPOSE_FILE, "config", "--format", "json"], {
    encoding: "utf8",
    timeout: 60_000,
    env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe.skipIf(!hasDockerCompose)("compose.yml under Docker Compose (skipped: the docker CLI with the compose plugin is not on PATH)", () => {
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "slugbase-compose-"));
  });

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("validates with an environment file made from .env.example plus generated secrets", () => {
    const result = compose(writeEnv(operatorEnv()));
    expect(result.status, result.stderr).toBe(0);
    const config = JSON.parse(result.stdout) as { services: Record<string, { environment: Record<string, string> }> };
    expect(Object.keys(config.services).sort()).toEqual(["postgres", "slugbase", "slugbase-worker"]);
    // What Compose resolves is what the structural test resolves for the credential split.
    expect(config.services["slugbase"]?.environment["DATABASE_MIGRATE_URL"]).toBe(`postgres://slugbase_migrator:${MIGRATOR_PASSWORD}@postgres:5432/slugbase`);
    expect(config.services["slugbase-worker"]?.environment["DATABASE_URL"]).toBe(`postgres://slugbase_app:${APP_PASSWORD}@postgres:5432/slugbase`);
    expect(config.services["slugbase-worker"]?.environment).not.toHaveProperty("DATABASE_MIGRATE_URL");
    expect(JSON.stringify(config.services["slugbase-worker"]?.environment)).not.toContain(SUPERUSER_PASSWORD);
  });

  it.each([...OPERATOR_VALUES.keys()])("refuses to resolve without %s, and does not print a secret", (key) => {
    const entries = operatorEnv();
    entries.delete(key);
    const result = compose(writeEnv(entries));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(key);
    for (const secret of [APP_PASSWORD, MIGRATOR_PASSWORD, SUPERUSER_PASSWORD]) {
      expect(result.stderr).not.toContain(secret);
    }
  });
});
