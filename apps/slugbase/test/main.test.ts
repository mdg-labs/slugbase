import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The entry point validates the configuration of its process type before
// anything else (doc 01 section 3 rule 5). The tests run it as a process, the
// way the image does.

const APP = resolve(import.meta.dirname, "..");

const SESSION_SECRET = randomBytes(48).toString("base64url");
const ENCRYPTION_KEY = randomBytes(32).toString("base64");

const valid = {
  NODE_ENV: "production",
  APP_ORIGIN: "https://bookmarks.example.com",
  DATABASE_URL: "postgres://slugbase_app:Zq8-prod-app-pw@db.internal:5432/slugbase",
  DATABASE_MIGRATE_URL: "postgres://slugbase_migrator:Zq8-prod-mig-pw@db.internal:5432/slugbase",
  SESSION_SECRET,
  ENCRYPTION_KEY,
  ENCRYPTION_KEY_ID: "k1",
};

function start(env: Record<string, string>, ...args: string[]) {
  const result = spawnSync(process.execPath, ["src/main.ts", ...args], {
    cwd: APP,
    env: { PATH: process.env["PATH"] ?? "", ...env },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe("apps/slugbase main", () => {
  it("starts the server with a valid production environment", () => {
    const { status, output } = start(valid);
    expect(status, output).toBe(0);
    expect(output).toContain("Configuration loaded");
  });

  it.each(["server", "worker", "migrate"])("accepts the %s command", (command) => {
    expect(start(valid, command).status).toBe(0);
  });

  it("exits non-zero naming the key and never the value when SESSION_SECRET is weak", () => {
    const { status, output } = start({ ...valid, SESSION_SECRET: "weak-secret-qx70" });
    expect(status).toBe(1);
    expect(output).toContain("SESSION_SECRET");
    expect(output).not.toContain("weak-secret-qx70");
    expect(output).not.toContain("Configuration loaded");
  });

  it("refuses an http APP_ORIGIN in production and a development default", () => {
    const { status, output } = start({
      ...valid,
      APP_ORIGIN: "http://insecure-qx71.example.com",
      DATABASE_URL: "postgres://slugbase_app:slugbase_app_dev_only@localhost:54329/slugbase_dev",
    });
    expect(status).toBe(1);
    expect(output).toContain("APP_ORIGIN");
    expect(output).toContain("DATABASE_URL");
    expect(output).not.toContain("insecure-qx71");
    expect(output).not.toContain("slugbase_app_dev_only");
  });

  it("refuses to start without any environment", () => {
    const { status, output } = start({});
    expect(status).toBe(1);
    expect(output).toContain("NODE_ENV");
  });

  it("validates the schema of the command it runs", () => {
    const migrateOnly = { NODE_ENV: valid.NODE_ENV, DATABASE_MIGRATE_URL: valid.DATABASE_MIGRATE_URL };
    expect(start(migrateOnly, "migrate").status).toBe(0);
    expect(start(migrateOnly, "worker").status).toBe(1);
  });

  it("warns once about unknown SLUGBASE_* keys, naming keys only", () => {
    const { status, output } = start({ ...valid, SLUGBASE_NOT_A_KEY: "value-qx72" });
    expect(status).toBe(0);
    expect(output).toContain("SLUGBASE_NOT_A_KEY");
    expect(output).not.toContain("value-qx72");
    expect(output.match(/Unknown SLUGBASE_/g)).toHaveLength(1);
  });

  it("exits non-zero for an unknown command", () => {
    const { status, output } = start(valid, "serve");
    expect(status).toBe(2);
    expect(output).toContain("Unknown command");
  });
});
