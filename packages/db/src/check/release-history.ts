import { execFileSync } from "node:child_process";

// What the expand/contract rule reads from git: the latest release tag, and the
// migrations and tables the package held at it (doc 05 section 5.2: "existed in
// the previous release").
//
// Release tags are `v<major>.<minor>.<patch>` with an optional semver
// pre-release suffix (`v1.0.0`, `v1.0.0-rc.1`); the leading `v` is optional.
// The image tags of the release docs (doc 13 Q12) are the same versions
// without the `v`. Only a tag of that shape counts, and the latest is the one
// with the highest semver precedence, wherever it points: release tags are made
// on main only, and the comparison needs the tag's tree, not its ancestry.
//
// When git cannot say whether a release tag exists, the answer is an error, which
// `runChecks` reports as a failure of the rule: a shallow clone hides history
// and tags, so it is refused outright, as is a package that is not in a git work
// tree. A full clone that lists no release tag has nothing to compare with, and
// then every object counts as unreleased.

const RELEASE_TAG = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

export interface ReleasedTable {
  schema: string;
  name: string;
  columns: string[];
}

export interface ReleaseState {
  /** The tag as it is written in git. */
  tag: string;
  /** The migration tags the journal listed at the release. */
  migrations: string[];
  /** The tables and columns the last migration of the release left behind. */
  tables: ReleasedTable[];
}

/** Runs git in the package directory without the GIT_* variables of an outer git run (a hook) that would point it elsewhere. */
function git(packageDir: string, args: readonly string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  try {
    return execFileSync("git", ["-C", packageDir, ...args], {
      encoding: "utf8",
      env,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : "unknown error";
    throw new Error(`git ${args.join(" ")} failed (${detail ?? "unknown error"})`);
  }
}

interface Version {
  numbers: [number, number, number];
  prerelease: string[] | undefined;
}

function parseVersion(tag: string): Version | undefined {
  const match = RELEASE_TAG.exec(tag);
  if (match === null) {
    return undefined;
  }
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split("."),
  };
}

/** Semver precedence: a negative number when `a` is the lower version. */
function compareVersions(a: Version, b: Version): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (a.numbers[index] ?? 0) - (b.numbers[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  if (a.prerelease === undefined || b.prerelease === undefined) {
    return a.prerelease === b.prerelease ? 0 : a.prerelease === undefined ? 1 : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const left = a.prerelease[index];
    const right = b.prerelease[index];
    if (left === undefined || right === undefined) {
      return left === undefined ? -1 : 1;
    }
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) {
      const difference = Number(left) - Number(right);
      if (difference !== 0) {
        return difference;
      }
    } else if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    } else if (left !== right) {
      return left < right ? -1 : 1;
    }
  }
  return 0;
}

/** The release tags of the repository, lowest first. Throws when git cannot list them reliably. */
export function releaseTags(packageDir: string): string[] {
  if (git(packageDir, ["rev-parse", "--is-inside-work-tree"]).trim() !== "true") {
    throw new Error("the package is not in a git work tree, so the release tags cannot be listed");
  }
  if (git(packageDir, ["rev-parse", "--is-shallow-repository"]).trim() !== "false") {
    throw new Error(
      "shallow clone: the release tags and the history behind them are not all here; fetch full history and tags (actions/checkout fetch-depth: 0)",
    );
  }
  return git(packageDir, ["tag", "--list"])
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => parseVersion(line) !== undefined)
    .sort((a, b) => compareVersions(parseVersion(a) as Version, parseVersion(b) as Version));
}

function showAtTag(packageDir: string, prefix: string, tag: string, path: string): string {
  return git(packageDir, ["show", `refs/tags/${tag}:${prefix}${path}`]);
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${what} is not valid JSON`);
  }
}

function objectField(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && key in value ? (value as Record<string, unknown>)[key] : undefined;
}

/** The migrations and tables of the package at a release tag. */
export function readReleaseState(packageDir: string, tag: string): ReleaseState {
  const prefix = git(packageDir, ["rev-parse", "--show-prefix"]).trim();
  const journal = parseJson(showAtTag(packageDir, prefix, tag, "migrations/meta/_journal.json"), `migrations/meta/_journal.json at ${tag}`);
  const entries = objectField(journal, "entries");
  if (!Array.isArray(entries)) {
    throw new Error(`migrations/meta/_journal.json at ${tag} has no entries list`);
  }
  const migrations = (entries as unknown[]).map((entry) => {
    const migration = objectField(entry, "tag");
    if (typeof migration !== "string" || migration === "") {
      throw new Error(`migrations/meta/_journal.json at ${tag} holds an entry without a tag`);
    }
    return migration;
  });
  const last = migrations.at(-1);
  if (last === undefined) {
    return { tag, migrations, tables: [] };
  }
  const stamp = /^(\d{14})_/.exec(last)?.[1];
  if (stamp === undefined) {
    throw new Error(`the migration ${last} at ${tag} has no timestamp to name its snapshot by`);
  }
  const snapshotFile = `migrations/meta/${stamp}_snapshot.json`;
  const snapshot = parseJson(showAtTag(packageDir, prefix, tag, snapshotFile), `${snapshotFile} at ${tag}`);
  const tables = objectField(snapshot, "tables");
  if (typeof tables !== "object" || tables === null || Array.isArray(tables)) {
    throw new Error(`${snapshotFile} at ${tag} has no tables object`);
  }
  const released: ReleasedTable[] = [];
  for (const [key, table] of Object.entries(tables)) {
    const name = objectField(table, "name");
    const schemaField = objectField(table, "schema");
    const columns = objectField(table, "columns");
    if (typeof name !== "string" || typeof columns !== "object" || columns === null) {
      throw new Error(`${snapshotFile} at ${tag} holds a table (${key}) this check cannot read`);
    }
    const schema = typeof schemaField === "string" && schemaField !== "" ? schemaField : key.includes(".") ? key.slice(0, key.indexOf(".")) : "public";
    released.push({
      schema,
      name,
      columns: Object.entries(columns).map(([columnKey, column]) => {
        const columnName = objectField(column, "name");
        return typeof columnName === "string" ? columnName : columnKey;
      }),
    });
  }
  return { tag, migrations, tables: released };
}

/** The latest release tag and the package at it, or undefined when the repository has no release tag. */
export function latestRelease(packageDir: string): ReleaseState | undefined {
  const tag = releaseTags(packageDir).at(-1);
  return tag === undefined ? undefined : readReleaseState(packageDir, tag);
}
