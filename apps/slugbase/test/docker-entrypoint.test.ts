import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The image entrypoint (doc 01 section 2.1, doc 05 section 5.3) is the only place
// the migrator credentials are held apart from the processes that serve. These
// tests run the real script against a stub `node` that records each invocation
// (its arguments and its whole environment), so what the server and worker
// children receive is asserted exactly.

const APP = resolve(import.meta.dirname, "..");
const ENTRYPOINT = join(APP, "docker-entrypoint.sh");

const MIGRATOR_URL = "postgres://slugbase_migrator:migrator-password@db.internal:5432/slugbase";

const BASE_ENV: Readonly<Record<string, string>> = {
  NODE_ENV: "production",
  APP_ORIGIN: "https://bookmarks.example.com",
  DATABASE_URL: "postgres://slugbase_app:app-password@db.internal:5432/slugbase",
  DATABASE_MIGRATE_URL: MIGRATOR_URL,
  SESSION_SECRET: "session-secret-of-the-test-run-at-least-32-characters",
  ENCRYPTION_KEY: "ZmFrZS1lbmNyeXB0aW9uLWtleS1mb3ItdGhlLXRlc3Q=",
  ENCRYPTION_KEY_ID: "k1",
};

// Variables a POSIX shell adds to the environment of its children by itself, and the PATH
// the test sets so that the stub is found; none of them comes from the entrypoint.
const NOT_FROM_ENTRYPOINT = new Set(["PWD", "OLDPWD", "SHLVL", "_", "PATH"]);

interface Invocation {
  argv: string[];
  env: Record<string, string>;
  pid: number;
}

let dir: string;

// A `node` that logs its arguments, pid and environment as one JSON line, then
// exits with the status the test asked for the first argument after the script.
// Nothing about the log location is passed through the environment: the child
// environment is what is asserted.
function writeStub(options: { migrateExit?: number; hold?: boolean } = {}): void {
  const log = join(dir, "invocations.log");
  const script = `#!/bin/sh
{
  printf '{"pid":%s,"argv":[' "$$"
  first=1
  for arg in "$@"; do
    if [ "$first" = 1 ]; then first=0; else printf ','; fi
    printf '"%s"' "$arg"
  done
  printf '],"env":{'
  first=1
  env | while IFS= read -r line; do
    if [ "$first" = 1 ]; then first=0; else printf ','; fi
    printf '"%s":"%s"' "\${line%%=*}" "\${line#*=}"
  done
  printf '}}\\n'
} >> ${JSON.stringify(log)}
case "$2" in
  migrate) exit ${String(options.migrateExit ?? 0)} ;;
esac
${
  options.hold === true
    ? `trap 'echo terminated >> ${JSON.stringify(join(dir, "signal.log"))}; exit 0' TERM
echo ready >> ${JSON.stringify(join(dir, "signal.log"))}
i=0
while [ "$i" -lt 100 ]; do sleep 0.1; i=$((i + 1)); done
exit 3`
    : "exit 0"
}
`;
  const stub = join(dir, "bin", "node");
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(stub, script);
  chmodSync(stub, 0o755);
}

function invocations(): Invocation[] {
  const log = join(dir, "invocations.log");
  if (!existsSync(log)) {
    return [];
  }
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const parsed = JSON.parse(line) as Invocation;
      return { ...parsed, env: Object.fromEntries(Object.entries(parsed.env).filter(([name]) => !NOT_FROM_ENTRYPOINT.has(name))) };
    });
}

function run(args: string[], env: Record<string, string>) {
  const result = spawnSync(ENTRYPOINT, args, {
    env: { PATH: `${join(dir, "bin")}:/usr/bin:/bin`, ...env },
    encoding: "utf8",
    timeout: 20_000,
  });
  return { status: result.status, signal: result.signal, output: `${result.stdout}${result.stderr}` };
}

function without(env: Readonly<Record<string, string>>, ...names: string[]): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !names.includes(name)));
}

function subcommands(): string[] {
  return invocations().map((invocation) => invocation.argv[1] ?? "");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "slugbase-entrypoint-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the entrypoint file", () => {
  it("is executable", () => {
    expect(statSync(ENTRYPOINT).mode & 0o111).not.toBe(0);
  });

  it("runs the built server bundle next to it", () => {
    writeStub();
    expect(run(["worker"], BASE_ENV).status).toBe(0);
    const [only] = invocations();
    expect(only?.argv[0]).toBe(join(APP, "dist", "main.js"));
  });
});

describe("server with migrate-on-start", () => {
  it.each<Record<string, string>>([{ MIGRATE_ON_START: "true" }, { MIGRATE_ON_START: "1" }, {}])(
    "migrates as the migrator, then serves without the migrator URL (%j)",
    (extra) => {
      writeStub();
      const given = { ...BASE_ENV, ...extra };
      const { status } = run(["server"], given);
      expect(status).toBe(0);

      const [migrate, server, ...rest] = invocations();
      expect(rest).toEqual([]);
      expect(migrate?.argv).toEqual([join(APP, "dist", "main.js"), "migrate"]);
      expect(migrate?.env).toEqual(given);

      expect(server?.argv).toEqual([join(APP, "dist", "main.js"), "server"]);
      expect(server?.env).toEqual({ ...without(given, "DATABASE_MIGRATE_URL"), MIGRATE_ON_START: "false" });
      expect(Object.values(server?.env ?? {}).join("\n")).not.toContain("migrator");
    },
  );

  it("exits with the failure of migrate and never starts the server", () => {
    writeStub({ migrateExit: 7 });
    const { status } = run(["server"], BASE_ENV);
    expect(status).toBe(7);
    expect(subcommands()).toEqual(["migrate"]);
  });

  it("does not start the server when the migrator URL is missing", () => {
    // Without a URL the stub's `migrate` would succeed, so the script itself must refuse.
    writeStub();
    const { status, output } = run(["server"], without(BASE_ENV, "DATABASE_MIGRATE_URL"));
    expect(status).not.toBe(0);
    expect(subcommands()).toEqual([]);
    expect(output).toContain("DATABASE_MIGRATE_URL");
  });

  it("does not start the server when the migrator URL is empty", () => {
    writeStub();
    const { status } = run(["server"], { ...BASE_ENV, DATABASE_MIGRATE_URL: "" });
    expect(status).not.toBe(0);
    expect(subcommands()).toEqual([]);
  });

  it.each(["yes", "True", "", " true", "2"])("refuses MIGRATE_ON_START=%j before anything runs", (value) => {
    writeStub();
    const { status, output } = run(["server"], { ...BASE_ENV, MIGRATE_ON_START: value });
    expect(status).not.toBe(0);
    expect(subcommands()).toEqual([]);
    expect(output).toContain("MIGRATE_ON_START");
  });
});

describe("server without migrate-on-start", () => {
  it.each(["false", "0"])("serves at once without the migrator URL (MIGRATE_ON_START=%s)", (value) => {
    writeStub();
    const given = { ...BASE_ENV, MIGRATE_ON_START: value };
    expect(run(["server"], given).status).toBe(0);
    const [server, ...rest] = invocations();
    expect(rest).toEqual([]);
    expect(server?.argv).toEqual([join(APP, "dist", "main.js"), "server"]);
    expect(server?.env).toEqual({ ...without(given, "DATABASE_MIGRATE_URL"), MIGRATE_ON_START: "false" });
  });

  it("serves without the migrator URL when none was given", () => {
    writeStub();
    const given = { ...without(BASE_ENV, "DATABASE_MIGRATE_URL"), MIGRATE_ON_START: "false" };
    expect(run(["server"], given).status).toBe(0);
    expect(invocations().map((invocation) => invocation.env)).toEqual([given]);
  });
});

describe("worker", () => {
  it.each<Record<string, string>>([{}, { MIGRATE_ON_START: "true" }, { MIGRATE_ON_START: "false" }])(
    "never receives the migrator URL and never migrates (%j)",
    (extra) => {
      writeStub();
      const given = { ...BASE_ENV, ...extra };
      expect(run(["worker"], given).status).toBe(0);
      const [worker, ...rest] = invocations();
      expect(rest).toEqual([]);
      expect(worker?.argv).toEqual([join(APP, "dist", "main.js"), "worker"]);
      expect(worker?.env).toEqual(without(given, "DATABASE_MIGRATE_URL"));
    },
  );
});

describe("migrate", () => {
  it("passes through with the environment as it is", () => {
    writeStub();
    expect(run(["migrate"], BASE_ENV).status).toBe(0);
    const [migrate, ...rest] = invocations();
    expect(rest).toEqual([]);
    expect(migrate?.argv).toEqual([join(APP, "dist", "main.js"), "migrate"]);
    expect(migrate?.env).toEqual(BASE_ENV);
  });

  it("exits with the status of migrate", () => {
    writeStub({ migrateExit: 9 });
    expect(run(["migrate"], BASE_ENV).status).toBe(9);
  });
});

describe("unknown commands", () => {
  it.each([{ args: ["bogus"] }, { args: ["Server"] }, { args: ["--with-worker"] }, { args: [""] }, { args: ["server", "extra"] }, { args: [] }])(
    "exit 2 and run nothing (%j)",
    ({ args }) => {
      writeStub();
      const { status } = run(args, BASE_ENV);
      expect(status).toBe(2);
      expect(subcommands()).toEqual([]);
    },
  );
});

describe("signals", () => {
  // `exec` replaces the shell with node, so the process the container runtime
  // signals (PID 1) is node itself: the stub must run under the entrypoint's pid.
  it.each([["server", { MIGRATE_ON_START: "false" }], ["worker", {}]] as const)("reach node itself for %s", async (command, extra) => {
    writeStub({ hold: true });
    const child = spawn(ENTRYPOINT, [command], { env: { PATH: `${join(dir, "bin")}:/usr/bin:/bin`, ...BASE_ENV, ...extra } });
    const exited = new Promise<number | null>((done) => {
      child.on("close", (code) => {
        done(code);
      });
    });
    const signalLog = join(dir, "signal.log");
    const deadline = Date.now() + 10_000;
    while (!existsSync(signalLog) && Date.now() < deadline) {
      await new Promise((wait) => setTimeout(wait, 50));
    }
    expect(existsSync(signalLog)).toBe(true);
    expect(invocations().at(-1)?.pid).toBe(child.pid);
    child.kill("SIGTERM");
    expect(await exited).toBe(0);
    expect(readFileSync(signalLog, "utf8")).toBe("ready\nterminated\n");
  });
});
