import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readyOf } from "./restore-drill.ts";
import type { Snapshot } from "./seed-instance.ts";

// What the upgrade drill (e2e/upgrade-drill.spec.ts) needs besides the helpers of the restore drill: the image it upgrades
// from, the commands of docs/self-hosting/upgrade.md it runs, and the comparisons that say whether the instance came
// through. A message that fails here names the call or the value that differs and never a password, a key or a code.

const REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const GUIDE = join(REPOSITORY_ROOT, "docs", "self-hosting", "upgrade.md");
const APP_PACKAGE = join(REPOSITORY_ROOT, "apps", "slugbase", "package.json");

/**
 * The image the drill upgrades from: `ghcr.io/mdg-labs/slugbase:1.0.0-rc.1`, pinned by the digest of its manifest list, so a
 * tag that moved would not change what the drill proves. The tag was pushed before signing was added (docs/self-hosting/upgrade.md,
 * "Verify the image"), so the drill does not verify a signature of it. When a release replaces the candidate as the oldest
 * version the project supports an upgrade from, this is the one line that changes.
 */
export const RELEASE_CANDIDATE_IMAGE = "ghcr.io/mdg-labs/slugbase@sha256:7f2993a3b15c236bda66ae003c1f3dad89656db5dac3f333968018225d63aa9c";

const PULL_MS = 5 * 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The image of the commit under test, which the job builds as `slugbase:e2e`: what the drill upgrades to. */
export function candidateImage(env: NodeJS.ProcessEnv = process.env): string {
  const image = env.SLUGBASE_IMAGE ?? env.E2E_IMAGE ?? "";
  if (image === "") {
    throw new Error("SLUGBASE_IMAGE is not set: build the image of this commit (docker build -f apps/slugbase/Dockerfile --build-arg BUILD_COMMIT=<commit> -t slugbase:e2e .) and name it");
  }
  if (image === RELEASE_CANDIDATE_IMAGE) {
    throw new Error("the image to upgrade to is the image to upgrade from");
  }
  return image;
}

/** The commit the image under test was built from, which `/version` must name. */
export function candidateCommit(env: NodeJS.ProcessEnv = process.env): string {
  const commit = env.BUILD_COMMIT ?? "";
  if (!/^[0-9a-f]{7,64}$/.test(commit)) {
    throw new Error("BUILD_COMMIT is not set to the commit the image under test was built from");
  }
  return commit;
}

/** The version of `apps/slugbase/package.json`, which the image reports as its version. */
export function appVersion(): string {
  const manifest: unknown = JSON.parse(readFileSync(APP_PACKAGE, "utf8"));
  const version = isRecord(manifest) ? manifest.version : undefined;
  if (typeof version !== "string" || version === "") {
    throw new Error("apps/slugbase/package.json has no version");
  }
  return version;
}

/** The upgrade guide as the drill reads it. */
export function readGuide(): string {
  return readFileSync(GUIDE, "utf8");
}

/** Whether the local Docker daemon holds the image. */
export function hasImage(image: string): boolean {
  return spawnSync("docker", ["image", "inspect", image], { stdio: "ignore", timeout: 60_000 }).status === 0;
}

/**
 * Pulls the image the way an operator who has never signed in to the registry does: with a Docker client configuration of
 * its own that holds no credential, so a registry that asked for one would fail the pull instead of being served by the
 * login of the machine the drill runs on.
 */
export function pullAnonymously(image: string): void {
  const config = mkdtempSync(join(tmpdir(), "slugbase-anonymous-docker-"));
  try {
    writeFileSync(join(config, "config.json"), "{}\n", { mode: 0o600 });
    const result = spawnSync("docker", ["pull", "--quiet", image], {
      env: { ...process.env, DOCKER_CONFIG: config },
      stdio: ["ignore", "ignore", "pipe"],
      encoding: "utf8",
      timeout: PULL_MS,
    });
    if (result.error !== undefined || result.status !== 0) {
      const tail = (result.stderr || result.error?.message || "").trim().split("\n").slice(-6).join("\n");
      throw new Error(`docker pull of the release candidate image failed:\n${tail}`);
    }
  } finally {
    rmSync(config, { recursive: true, force: true });
  }
}

/** The lines of the guide's code blocks (between fences, indented or not), trimmed, without the empty ones. */
export function guideCodeLines(guide: string): string[] {
  const lines: string[] = [];
  let inside = false;
  for (const line of guide.split("\n")) {
    if (/^\s*```/.test(line)) {
      inside = !inside;
    } else if (inside && line.trim() !== "") {
      lines.push(line.trim());
    }
  }
  return lines;
}

/** What the drill runs, as the guide gives it. */
export interface GuideCommands {
  /** The arguments of `docker compose` for the guide's start: `up -d`. */
  up: string[];
  /** The arguments of `docker compose` for the guide's own migration: `run --rm slugbase migrate`. */
  migrate: string[];
  /** The path of the guide's `curl` of the readiness probe. */
  readyPath: string;
  /** The path of the guide's `curl` of the version. */
  versionPath: string;
}

const COMPOSE_UP = "docker compose up -d";
const COMPOSE_PULL = "docker compose pull";
const COMPOSE_MIGRATE = "docker compose run --rm slugbase migrate";
const CURL = /^curl -fsS http:\/\/127\.0\.0\.1:\d+(\/[a-z]+)$/;
const IMAGE_SETTING = /^SLUGBASE_IMAGE=\S+$/;
const PS_SENTENCE = "`docker compose ps` shows `slugbase` as healthy";

/**
 * The commands of the guide that the drill runs, or an error that names every one the guide no longer has. The drill runs
 * `docker compose up -d`, `docker compose run --rm slugbase migrate` and the `curl` of `/ready` and `/version`, and sets
 * `SLUGBASE_IMAGE` in the env file as step 3 says, so each of them has to be a line of a code block of the guide.
 * `docker compose pull` is a step it does not run for the candidate, which is built on the runner and is in no registry; the
 * guide has to keep it, so that the one step the drill skips is still one a reader is told to take. The sentence that names
 * `docker compose ps` is the guide's wording of the health check the drill makes through it.
 */
export function guideCommands(guide: string): GuideCommands {
  const lines = guideCodeLines(guide);
  const missing: string[] = [];
  const has = (line: string): boolean => lines.includes(line);
  for (const command of [COMPOSE_PULL, COMPOSE_UP, COMPOSE_MIGRATE]) {
    if (!has(command)) {
      missing.push(command);
    }
  }
  if (!lines.some((line) => IMAGE_SETTING.test(line))) {
    missing.push("SLUGBASE_IMAGE=<image>");
  }
  const paths = lines.flatMap((line) => CURL.exec(line)?.[1] ?? []);
  for (const path of ["/ready", "/version"]) {
    if (!paths.includes(path)) {
      missing.push(`curl -fsS http://127.0.0.1:<port>${path}`);
    }
  }
  if (!guide.includes(PS_SENTENCE)) {
    missing.push(PS_SENTENCE);
  }
  if (missing.length > 0) {
    throw new Error(`the upgrade guide no longer has what the drill runs: ${missing.join("; ")}`);
  }
  return { up: COMPOSE_UP.split(" ").slice(2), migrate: COMPOSE_MIGRATE.split(" ").slice(2), readyPath: "/ready", versionPath: "/version" };
}

/** Writes `KEY=value` into an env file in place, as step 3 of the guide edits `.env`; the file keeps its mode. */
export function setEnvValue(file: string, key: string, value: string): void {
  const lines = readFileSync(file, "utf8").split("\n");
  const at = lines.findIndex((line) => line.startsWith(`${key}=`));
  if (at >= 0) {
    lines[at] = `${key}=${value}`;
  } else {
    const end = lines.at(-1) === "" ? lines.length - 1 : lines.length;
    lines.splice(end, 0, `${key}=${value}`);
  }
  writeFileSync(file, lines.join("\n"));
}

/** The health of the service in the output of `docker compose ps --format json` (one object per line, or an array). */
export function healthOf(output: string, service: string): string | undefined {
  const text = output.trim();
  if (text === "") {
    return undefined;
  }
  const parsed: unknown[] = text.startsWith("[") ? (JSON.parse(text) as unknown[]) : text.split("\n").map((line) => JSON.parse(line) as unknown);
  for (const entry of parsed) {
    if (isRecord(entry) && entry.Service === service) {
      return typeof entry.Health === "string" && entry.Health !== "" ? entry.Health : typeof entry.State === "string" ? entry.State : undefined;
    }
  }
  return undefined;
}

/** What the owner sees of the instance: the counts that the read-back compares, from the snapshot and the shares. */
export interface Instance {
  snapshot: Snapshot;
  /** The shares of the bookmark the owner shared. */
  shares: number;
}

/** What `/go/<slug>` answered. */
export interface Forwarded {
  slug: string;
  status: number;
  location: string | null;
}

/**
 * What differs between the instance as it was seeded and as the owner sees it after the upgrade: the counts of bookmarks,
 * folders, tags and shares, every bookmark, folder and tag as it was, and every slug forwarding to its bookmark. An empty
 * list means the instance came through.
 */
export function readBackProblems(seeded: Instance, now: Instance, forwarded: readonly Forwarded[]): string[] {
  const problems: string[] = [];
  const counts: [string, number, number][] = [
    ["bookmarks", seeded.snapshot.bookmarks.length, now.snapshot.bookmarks.length],
    ["folders", seeded.snapshot.folders.length, now.snapshot.folders.length],
    ["tags", seeded.snapshot.tags.length, now.snapshot.tags.length],
    ["shares", seeded.shares, now.shares],
  ];
  for (const [what, was, is] of counts) {
    if (was !== is) {
      problems.push(`${String(is)} ${what} after the upgrade, ${String(was)} seeded`);
    }
  }
  for (const bookmark of seeded.snapshot.bookmarks) {
    const found = now.snapshot.bookmarks.find((candidate) => candidate.id === bookmark.id);
    if (found === undefined) {
      problems.push(`the bookmark "${bookmark.title}" is missing`);
    } else if (JSON.stringify(found) !== JSON.stringify(bookmark)) {
      problems.push(`the bookmark "${bookmark.title}" is not as it was seeded`);
    }
  }
  for (const [what, was, is] of [
    ["folder", seeded.snapshot.folders, now.snapshot.folders],
    ["tag", seeded.snapshot.tags, now.snapshot.tags],
  ] as const) {
    for (const entry of was) {
      const found = is.find((candidate) => candidate.name === entry.name);
      if (found === undefined) {
        problems.push(`the ${what} "${entry.name}" is missing`);
      } else if (found.bookmarkCount !== entry.bookmarkCount) {
        problems.push(`the ${what} "${entry.name}" holds ${String(found.bookmarkCount)} bookmarks, ${String(entry.bookmarkCount)} seeded`);
      }
    }
  }
  for (const bookmark of seeded.snapshot.bookmarks) {
    if (bookmark.slug === null) {
      continue;
    }
    const answer = forwarded.find((candidate) => candidate.slug === bookmark.slug);
    if (answer === undefined) {
      problems.push(`/go/${bookmark.slug} was not tried`);
    } else if (answer.status !== 302 || answer.location !== bookmark.url) {
      problems.push(`/go/${bookmark.slug} answered ${String(answer.status)} to ${answer.location ?? "no address"}, expected 302 to ${bookmark.url}`);
    }
  }
  return problems;
}

/** What differs between the answer of `/version` and the image under test; an empty list means `/version` names it. */
export function versionProblems(body: unknown, expected: { commit: string; version: string }): string[] {
  if (!isRecord(body)) {
    return ["/version did not answer with an object"];
  }
  const problems: string[] = [];
  if (body.commit !== expected.commit) {
    problems.push(`/version names the commit ${JSON.stringify(body.commit)}, expected ${expected.commit}`);
  }
  if (body.version !== expected.version) {
    problems.push(`/version names the version ${JSON.stringify(body.version)}, expected ${expected.version}`);
  }
  return problems;
}

/** The answer of `/ready` while the server is up and not ready. */
export interface NotReady {
  status: number;
  expected: unknown;
  applied: unknown;
}

/**
 * Waits for `/ready` to answer 503, which a server that has not migrated does once it listens; the recreation of the container
 * before that refuses or drops connections, and the release candidate still stopping answers 200. The error names the last thing seen.
 */
export async function waitForNotReady(baseUrl: string, seconds = 120): Promise<NotReady> {
  const deadline = Date.now() + seconds * 1000;
  let last = "no answer";
  for (;;) {
    try {
      const ready = await readyOf(baseUrl);
      if (ready.status === 503) {
        return ready;
      }
      last = `status ${String(ready.status)}`;
    } catch (error) {
      last = error instanceof Error ? error.message : "an error";
    }
    if (Date.now() >= deadline) {
      throw new Error(`/ready did not answer 503 within ${String(seconds)} seconds (last: ${last})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}
