import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ApiClient, ApiResponse } from "./instance-admin.ts";
import { totpCode, totpStep } from "./totp.ts";

// What the backup and restore drill (e2e/restore-drill.spec.ts) needs besides Playwright: the stack of its own
// (e2e/restore-drill-stack.sh), the docker compose commands of docs/self-hosting/backup-restore.md, and a client
// of the HTTP API that carries the session cookie by hand, because the stack answers over http at an address
// other than the https origin it is configured with. A message that fails here names the call and its status,
// never a password, a key, a code or a cookie; the output of a command has every value of the stack's env file
// that is a secret replaced.

const REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const STACK_SCRIPT = join(REPOSITORY_ROOT, "e2e", "restore-drill-stack.sh");
const GUIDE = join(REPOSITORY_ROOT, "docs", "self-hosting", "backup-restore.md");
const JOURNAL = join(REPOSITORY_ROOT, "packages", "db", "migrations", "meta", "_journal.json");

/** How long the stack may take to be ready: a build of the image from this checkout is part of it. */
const STACK_START_MS = 20 * 60_000;
/** How long the stack's script may take to remove the stack once told it is done. */
const STACK_STOP_MS = 3 * 60_000;
const COMMAND_MS = 3 * 60_000;
const REQUEST_MS = 15_000;
const POLL_MS = 1_000;

/** The keys of the stack's env file whose values are secrets. */
const SECRET_KEY = /(PASSWORD|SECRET|ENCRYPTION_KEY)$/;
/** The variables the docker CLI needs to find its daemon; scripts/smoke-image.sh keeps the same ones. */
const DOCKER_VARIABLES = ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH", "XDG_RUNTIME_DIR"];

export interface StackHandle {
  project: string;
  envFile: string;
  composeArgs: string[];
  baseUrl: string;
  appOrigin: string;
  setupToken: string;
  workDir: string;
  postgresMajor: number;
}

export interface DrillStack extends StackHandle {
  /** Secret values to replace in anything that is reported. */
  secrets: string[];
  /** Ends the stack: removes it when `passed`, and otherwise makes the script print the logs of the containers first. */
  finish: (passed: boolean) => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHandle(value: unknown): value is StackHandle {
  return (
    isRecord(value) &&
    ["project", "envFile", "baseUrl", "appOrigin", "setupToken", "workDir"].every((key) => typeof value[key] === "string") &&
    typeof value.postgresMajor === "number" &&
    Array.isArray(value.composeArgs) &&
    value.composeArgs.every((arg) => typeof arg === "string")
  );
}

/** The `KEY=value` lines of an env file. */
export function parseEnvFile(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) {
      values.set(line.slice(0, at), line.slice(at + 1));
    }
  }
  return values;
}

/** The values of an env file that are secrets. */
export function secretValues(env: Map<string, string>): string[] {
  return [...env].filter(([key, value]) => SECRET_KEY.test(key) && value !== "").map(([, value]) => value);
}

export function redact(text: string, secrets: readonly string[]): string {
  return secrets.reduce((current, secret) => (secret === "" ? current : current.split(secret).join("[redacted]")), text);
}

/** Starts the stack of the drill and waits until its script reports it ready. */
export async function startDrillStack(env: NodeJS.ProcessEnv = process.env): Promise<DrillStack> {
  const child: ChildProcess = spawn("bash", [STACK_SCRIPT], { stdio: ["pipe", "pipe", "inherit"], env });
  const exited = new Promise<number>((resolve) => {
    child.once("close", (code, signal) => {
      resolve(code ?? (signal === null ? 1 : 128));
    });
  });
  let buffered = "";
  const handleFile = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`the stack of the drill was not ready within ${String(STACK_START_MS / 60_000)} minutes`));
    }, STACK_START_MS);
    child.stdout?.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        process.stdout.write(`${line}\n`);
        if (line.startsWith("ready ")) {
          clearTimeout(timer);
          resolve(line.slice("ready ".length));
        }
      }
    });
    void exited.then((code) => {
      clearTimeout(timer);
      reject(new Error(`the script of the stack ended with status ${String(code)} before the stack was ready`));
    });
  });
  const handle: unknown = JSON.parse(readFileSync(handleFile, "utf8"));
  if (!isHandle(handle)) {
    child.kill();
    throw new Error("the stack of the drill wrote a handle that is not what the drill reads");
  }
  const secrets = [...secretValues(parseEnvFile(readFileSync(handle.envFile, "utf8"))), handle.setupToken];
  return {
    ...handle,
    secrets,
    finish: async (passed) => {
      child.stdin?.end(passed ? "done\n" : "failed\n");
      const timer = setTimeout(() => {
        child.kill();
      }, STACK_STOP_MS);
      try {
        await exited;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function dockerEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(DOCKER_VARIABLES.flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name]]])));
}

export interface ComposeOptions {
  /** Read the standard input from this file. */
  stdinFile?: string;
  /** Write the standard output to this file, created readable by this user only. */
  stdoutFile?: string;
  /** Another env file than the stack's own. */
  envFile?: string;
  /** The command may fail; its status is returned. */
  allowFailure?: boolean;
}

export interface ComposeResult {
  status: number;
  stdout: string;
}

/**
 * `docker compose` of the stack's project, as the guide runs it, with only the stack's values (the shell's own
 * variables would win over the env file). A command that fails throws with the end of its error output.
 */
export function compose(stack: DrillStack, args: readonly string[], options: ComposeOptions = {}): ComposeResult {
  const opened: number[] = [];
  const open = (path: string, flags: string, mode?: number): number => {
    const descriptor = openSync(path, flags, mode);
    opened.push(descriptor);
    return descriptor;
  };
  try {
    const stdin = options.stdinFile === undefined ? "ignore" : open(options.stdinFile, "r");
    const stdout = options.stdoutFile === undefined ? "pipe" : open(options.stdoutFile, "w", 0o600);
    const result = spawnSync(
      "docker",
      ["compose", "--ansi", "never", "--project-name", stack.project, "--env-file", options.envFile ?? stack.envFile, ...stack.composeArgs, ...args],
      { env: dockerEnvironment(), stdio: [stdin, stdout, "pipe"], encoding: "utf8", timeout: COMMAND_MS },
    );
    if (result.error !== undefined) {
      throw new Error(`docker compose ${args.join(" ")} could not run: ${result.error.message}`);
    }
    const status = result.status ?? 1;
    if (status !== 0 && options.allowFailure !== true) {
      const tail = redact(result.stderr, stack.secrets).trim().split("\n").slice(-12).join("\n");
      throw new Error(`docker compose ${args.join(" ")} ended with status ${String(status)}:\n${tail}`);
    }
    return { status, stdout: typeof result.stdout === "string" ? result.stdout : "" };
  } finally {
    for (const descriptor of opened) {
      closeSync(descriptor);
    }
  }
}

/** The guide's dump: `pg_dump` as the superuser `slugbase`, in the custom format, into a file only this user can read. */
export function dumpDatabase(stack: DrillStack, file: string): void {
  mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
  compose(stack, ["exec", "-T", "postgres", "pg_dump", "-U", "slugbase", "-d", "slugbase", "--format=custom"], { stdoutFile: file });
}

/** The tables of the `public` schema of the `slugbase` database, counted by `psql`. */
export function tableCount(stack: DrillStack): number {
  const { stdout } = compose(stack, [
    "exec", "-T", "postgres", "psql", "-U", "slugbase", "-d", "slugbase", "--no-psqlrc", "--tuples-only", "--no-align",
    "-v", "ON_ERROR_STOP=1", "-c", "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'",
  ]);
  const count = Number(stdout.trim());
  if (!Number.isInteger(count)) {
    throw new Error("psql did not answer with a number of tables");
  }
  return count;
}

/** Splits a command line into words the way a POSIX shell does for plain words and single or double quotes. */
export function shellWords(line: string): string[] {
  const words: string[] = [];
  let word: string | undefined;
  let quote: string | undefined;
  for (const char of line) {
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      } else {
        word = (word ?? "") + char;
      }
    } else if (char === "'" || char === '"') {
      quote = char;
      word ??= "";
    } else if (/\s/.test(char)) {
      if (word !== undefined) {
        words.push(word);
        word = undefined;
      }
    } else {
      word = (word ?? "") + char;
    }
  }
  if (quote !== undefined) {
    throw new Error("a quote in the command line is not closed");
  }
  if (word !== undefined) {
    words.push(word);
  }
  return words;
}

/**
 * The arguments of `docker compose` in the guide's wait for the database of a new server: the one command of the
 * guide that runs `pg_isready`. The drill runs what the guide says, so a change to the guide's wait is run here.
 */
export function guideWaitArguments(guide: string): string[] {
  const commands = guide.split("\n").filter((line) => /^\s*docker compose .*\bpg_isready\b/.test(line));
  if (commands.length !== 1) {
    throw new Error(`the guide has ${String(commands.length)} commands that run pg_isready, and the drill needs exactly one`);
  }
  const [docker, subcommand, ...rest] = shellWords(commands[0]?.trim() ?? "");
  if (docker !== "docker" || subcommand !== "compose" || rest.length === 0) {
    throw new Error("the guide's wait for the database is not a docker compose command");
  }
  return rest;
}

/**
 * Waits for the final server of a new volume with the command the guide gives. The server that PostgreSQL starts
 * while it initialises a volume answers on its Unix socket, which `docker compose exec` reaches, and not over
 * TCP. The command is bounded by its own timeout and fails when the server never comes up.
 */
export function waitForDatabase(stack: DrillStack): void {
  compose(stack, guideWaitArguments(readFileSync(GUIDE, "utf8")));
}

/** The number of migrations the checkout ships: the level `/ready` must report. */
export function shippedMigrations(): number {
  const journal: unknown = JSON.parse(readFileSync(JOURNAL, "utf8"));
  const entries = isRecord(journal) ? journal.entries : undefined;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("the migration journal lists no migration");
  }
  return entries.length;
}

/** Writes a copy of the stack's env file with `ENCRYPTION_KEY` replaced, readable by this user only; returns its path. */
export function envFileWithKey(stack: DrillStack, key: string, name: string): string {
  const lines = readFileSync(stack.envFile, "utf8").split("\n");
  if (!lines.some((line) => line.startsWith("ENCRYPTION_KEY="))) {
    throw new Error("the env file of the stack has no ENCRYPTION_KEY");
  }
  const path = join(stack.workDir, name);
  writeFileSync(path, lines.map((line) => (line.startsWith("ENCRYPTION_KEY=") ? `ENCRYPTION_KEY=${key}` : line)).join("\n"), { mode: 0o600 });
  stack.secrets.push(key);
  return path;
}

/** One answer of the server. */
export class Reply implements ApiResponse {
  readonly statusCode: number;
  readonly headers: Headers;
  readonly body: string;

  constructor(statusCode: number, headers: Headers, body: string) {
    this.statusCode = statusCode;
    this.headers = headers;
    this.body = body;
  }

  ok(): boolean {
    return this.statusCode >= 200 && this.statusCode < 300;
  }

  status(): number {
    return this.statusCode;
  }

  json(): Promise<unknown> {
    return Promise.resolve(JSON.parse(this.body) as unknown);
  }
}

/** The name and value of a `Set-Cookie` header, and whether it ends the cookie. */
export function parseSetCookie(header: string): { name: string; value: string; ends: boolean } | undefined {
  const [pair = "", ...attributes] = header.split(";").map((part) => part.trim());
  const at = pair.indexOf("=");
  if (at <= 0) {
    return undefined;
  }
  const value = pair.slice(at + 1);
  const ends = value === "" || attributes.some((attribute) => /^max-age=(0|-\d+)$/i.test(attribute));
  return { name: pair.slice(0, at), value, ends };
}

/**
 * A client of the HTTP API with a session of its own. The cookie is Secure and `__Host-` prefixed, so it is kept and sent by hand;
 * a mutation carries the origin the server is configured with, which it requires of the application itself.
 */
export class Session implements ApiClient {
  readonly baseUrl: string;
  readonly origin: string;
  private readonly cookies = new Map<string, string>();

  constructor(baseUrl: string, origin: string) {
    this.baseUrl = baseUrl;
    this.origin = origin;
  }

  async send(method: string, path: string, options: { headers?: Record<string, string>; data?: unknown } = {}): Promise<Reply> {
    const headers: Record<string, string> = { ...options.headers };
    if (this.cookies.size > 0) {
      headers.cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    }
    const response = await fetch(new URL(path, this.baseUrl), {
      method,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_MS),
      ...(options.data === undefined ? {} : { body: JSON.stringify(options.data) }),
    });
    for (const header of response.headers.getSetCookie()) {
      const cookie = parseSetCookie(header);
      if (cookie !== undefined) {
        if (cookie.ends) {
          this.cookies.delete(cookie.name);
        } else {
          this.cookies.set(cookie.name, cookie.value);
        }
      }
    }
    return new Reply(response.status, response.headers, await response.text());
  }

  get(path: string): Promise<Reply> {
    return this.send("GET", path);
  }

  post(path: string, options: { headers: Record<string, string>; data?: unknown }): Promise<Reply> {
    return this.send("POST", path, options);
  }

  /** A mutation with the origin and a JSON body. */
  mutate(method: "POST" | "PATCH" | "PUT" | "DELETE", path: string, data?: unknown): Promise<Reply> {
    return this.send(method, path, {
      headers: { origin: this.origin, "content-type": "application/json" },
      ...(data === undefined ? {} : { data }),
    });
  }

  /** The answer to a mutation, which must have the status asked for. */
  async expect(method: "POST" | "PATCH" | "PUT" | "DELETE", path: string, status: number, data?: unknown): Promise<unknown> {
    const reply = await this.mutate(method, path, data);
    if (reply.status() !== status) {
      throw new Error(`${method} ${path} answered ${String(reply.status())}, expected ${String(status)}`);
    }
    return reply.body === "" ? undefined : reply.json();
  }

  /** The answer to a read, which must be 200. */
  async read(path: string): Promise<unknown> {
    const reply = await this.get(path);
    if (reply.status() !== 200) {
      throw new Error(`GET ${path} answered ${String(reply.status())}, expected 200`);
    }
    return reply.json();
  }
}

/**
 * The code to give for the sign-in after `afterStep`: a code is accepted once and only for a later step than the last one accepted,
 * so this waits for the next time step if the clock is still in that one.
 */
export async function codeAfter(key: string, afterStep: number): Promise<{ code: string; step: number }> {
  while (totpStep(Date.now()) <= afterStep) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const step = totpStep(Date.now());
  return { code: totpCode(key, step), step };
}

/** The `/ready` answer of the server: the status and the migration level. */
export async function readyOf(baseUrl: string): Promise<{ status: number; database: unknown; expected: unknown; applied: unknown }> {
  const response = await fetch(new URL("/ready", baseUrl), { signal: AbortSignal.timeout(REQUEST_MS) });
  const body: unknown = await response.json();
  const migrations = isRecord(body) ? body.migrations : undefined;
  return {
    status: response.status,
    database: isRecord(body) ? body.database : undefined,
    expected: isRecord(migrations) ? migrations.expected : undefined,
    applied: isRecord(migrations) ? migrations.applied : undefined,
  };
}

/** Waits for `/ready` to answer 200, at most `seconds`; the error names the last status. */
export async function waitForReady(baseUrl: string, seconds = 180): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  let last = "no answer";
  for (;;) {
    try {
      const { status } = await readyOf(baseUrl);
      if (status === 200) {
        return;
      }
      last = `status ${String(status)}`;
    } catch (error) {
      last = error instanceof Error ? error.message : "an error";
    }
    if (Date.now() >= deadline) {
      throw new Error(`/ready did not answer 200 within ${String(seconds)} seconds (last: ${last})`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}
