import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  APP_PASSWORD,
  COMPOSE_FILE,
  COMPOSE_PG17_FILE,
  hasDockerCompose,
  MIGRATOR_PASSWORD,
  OPERATOR_VALUES,
  operatorEnv,
  ROOT,
  SUPERUSER_PASSWORD,
} from "./compose-support.ts";

// These cases need Docker Compose itself: that it accepts compose.yml with an
// environment made from .env.example plus generated secrets, and what it prints
// when a required key is missing. They run wherever the docker CLI is present;
// the CI build job, which has it, runs them. The structure of the stack, which
// needs no CLI, is checked in compose.integration.test.ts. `compose config`
// needs no daemon. The same goes for compose.pg17.yml, merged over compose.yml by
// Compose itself: the database image and the mounts it resolves to are what the
// e2e workflow runs.

let directory: string;

function writeEnv(entries: ReadonlyMap<string, string>): string {
  const file = join(directory, `env-${String(Math.random()).slice(2)}`);
  writeFileSync(file, [...entries].map(([key, value]) => `${key}=${value}`).join("\n") + "\n");
  return file;
}

function compose(file: string, overrides: readonly string[] = [], projectDirectory?: string): { status: number | null; stdout: string; stderr: string } {
  const files = [COMPOSE_FILE, ...overrides].flatMap((path) => ["-f", path]);
  const directoryArguments = projectDirectory === undefined ? [] : ["--project-directory", projectDirectory];
  const result = spawnSync("docker", ["compose", "--project-name", "slugbase-compose-test", "--env-file", file, ...directoryArguments, ...files, "config", "--format", "json"], {
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

  describe("OIDC providers of the operator", () => {
    type Services = Record<string, { environment: Record<string, string> }>;
    const oidcKeys = ["OIDC_TEST_CLIENT_ID", "OIDC_TEST_CLIENT_SECRET", "OIDC_TEST_ISSUER_URL"];

    function services(projectDirectory: string): Services {
      const result = compose(writeEnv(operatorEnv()), [], projectDirectory);
      expect(result.status, result.stderr).toBe(0);
      return (JSON.parse(result.stdout) as { services: Services }).services;
    }

    it("passes the keys of .env.oidc in the project directory to the server and not to the worker, and the stack resolves as before", () => {
      const project = mkdtempSync(join(directory, "project-"));
      writeFileSync(join(project, ".env.oidc"), oidcKeys.map((key) => `${key}=placeholder`).join("\n") + "\n");
      const config = services(project);
      for (const key of oidcKeys) {
        expect(config["slugbase"]?.environment[key], key).toBe("placeholder");
        expect(config["slugbase-worker"]?.environment, key).not.toHaveProperty(key);
      }
      expect(config["slugbase"]?.environment["DATABASE_MIGRATE_URL"]).toBe(`postgres://slugbase_migrator:${MIGRATOR_PASSWORD}@postgres:5432/slugbase`);
      expect(config["slugbase-worker"]?.environment).not.toHaveProperty("DATABASE_MIGRATE_URL");
    });

    it("resolves with no .env.oidc, and the server then has no OIDC key", () => {
      const config = services(mkdtempSync(join(directory, "project-")));
      for (const name of ["slugbase", "slugbase-worker"]) {
        expect(Object.keys(config[name]?.environment ?? {}).filter((key) => key.startsWith("OIDC_")), name).toEqual([]);
      }
    });

    it("keeps the required-key guards when .env.oidc is present", () => {
      const project = mkdtempSync(join(directory, "project-"));
      writeFileSync(join(project, ".env.oidc"), "OIDC_TEST_CLIENT_ID=placeholder\n");
      const entries = operatorEnv();
      entries.delete("APP_ORIGIN");
      const result = compose(writeEnv(entries), [], project);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("APP_ORIGIN");
    });
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

  interface Mount {
    type: string;
    source: string;
    target: string;
  }

  function postgresOf(overrides: readonly string[]): { image: string; volumes: Mount[] } {
    const result = compose(writeEnv(operatorEnv()), overrides);
    expect(result.status, result.stderr).toBe(0);
    const config = JSON.parse(result.stdout) as { services: Record<string, { image: string; volumes: Mount[] }> };
    const postgres = config.services["postgres"];
    expect(postgres).toBeDefined();
    return postgres as { image: string; volumes: Mount[] };
  }

  /** The data volume and the role script, as Compose resolves them (the source of a bind mount is an absolute path). */
  function mounts(volumes: Mount[]): [string, string, string][] {
    return volumes.map((mount) => [mount.type, mount.type === "bind" ? mount.source.replace(ROOT, "<root>") : mount.source, mount.target]);
  }

  it("runs PostgreSQL 18 with the data volume under /var/lib/postgresql when no override is given", () => {
    const postgres = postgresOf([]);
    expect(postgres.image).toBe("postgres:18");
    expect(mounts(postgres.volumes)).toEqual([
      ["volume", "postgres-data", "/var/lib/postgresql"],
      ["bind", "<root>/packages/db/provision/roles.sql", "/docker-entrypoint-initdb.d/10-roles.sql"],
    ]);
  });

  it("runs PostgreSQL 17 with the data volume at /var/lib/postgresql/data, and nothing at the PostgreSQL 18 path, under compose.pg17.yml", () => {
    const postgres = postgresOf([COMPOSE_PG17_FILE]);
    expect(postgres.image).toBe("postgres:17");
    expect(mounts(postgres.volumes)).toEqual([
      ["volume", "postgres-data", "/var/lib/postgresql/data"],
      ["bind", "<root>/packages/db/provision/roles.sql", "/docker-entrypoint-initdb.d/10-roles.sql"],
    ]);
  });
});
