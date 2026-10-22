import { execFileSync } from "node:child_process";
import { splitStatements } from "../migrate.ts";
import { analyseSql, functionNameKey, functionStatementOf, grantObject, type AnalysedStatement, type FunctionIdentity, type TableName } from "./migration-statements.ts";

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
//
// The release also states which table privileges its custom SQL left (see
// `readReleasedPrivileges`): a migration that re-emits src/sql/ carries them again. The function
// GRANT and REVOKE statements of a custom step are read the same way (`functionPrivilegeStatements`),
// for the REVOKE statements on functions that an earlier contract migration ran.

const RELEASE_TAG = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const CUSTOM_SQL_MARKER = /^-- slugbase:custom-sql sha256=[0-9a-f]{64}\b/;
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

/** A GRANT or REVOKE on tables, or on a wider object (`tables` undefined), as it is compared with the release's. */
export interface PrivilegeStatement {
  /** The statement with its comments removed and its whitespace runs collapsed to one space (see `privilegeStatements`). */
  form: string;
  revoke: boolean;
  tables: TableName[] | undefined;
}

/**
 * The custom-SQL step of a migration file: its statements from the one that starts with
 * `-- slugbase:custom-sql` to the end of the file (the generator appends the step after the schema
 * statements), or undefined when the file has none. Throws when the step cannot be scanned.
 */
export function customStep(sql: string): AnalysedStatement[] | undefined {
  const chunks = splitStatements(sql);
  const start = chunks.findIndex((chunk) => CUSTOM_SQL_MARKER.test(chunk));
  return start === -1 ? undefined : chunks.slice(start).flatMap((chunk) => analyseSql(chunk));
}

/**
 * A statement in the form two statements are compared in: its comments removed, as `analyseSql` gives it, and its
 * whitespace runs collapsed to one space. A statement with a quoted name or a string is compared as written, since
 * whitespace inside quotes belongs to the name. Letter case and the order of names stay as written.
 */
export function statementForm(statement: AnalysedStatement): string {
  const text = statement.text.trim();
  return /['"$]/.test(text) ? text : text.replace(/[ \t\n\r\f\v]+/g, " ");
}

/**
 * The table-privilege statements of a step in order: every GRANT and REVOKE that is not on a function or
 * a schema's CREATE, which can change what a role may do on a table. A statement is compared in the form
 * `analyseSql` gives, with its whitespace runs collapsed to one space, so a re-emit that only breaks lines
 * differently matches. Letter case, the order of roles and tables and the quoting of names are kept as
 * written: a statement that differs in any of them is another statement. A statement with a quoted name or
 * a string is compared as written outright, since whitespace inside quotes belongs to the name.
 *
 * Undefined when a GRANT or REVOKE of the step is one the reader does not place, since the step then does
 * not show what it leaves a table's privileges as.
 */
export function privilegeStatements(step: readonly AnalysedStatement[]): PrivilegeStatement[] | undefined {
  const found: PrivilegeStatement[] = [];
  for (const statement of step) {
    const [operation, ...rest] = statement.operations;
    const text = statement.text.trim();
    const form = statementForm(statement);
    if (operation?.kind === "revoke" && rest.length === 0) {
      found.push({ form, revoke: true, tables: operation.tables });
      continue;
    }
    // A REVOKE on one function touches no table, and a step that holds one still shows what it leaves a table as.
    if (!/^(grant|revoke)\b/i.test(text) || functionStatementOf(statement) !== undefined) {
      continue;
    }
    const object = grantObject(statement);
    if (object !== undefined) {
      found.push({ form, revoke: false, tables: object.tables });
    } else if (statement.operations.some((candidate) => candidate.kind === "unknown")) {
      return undefined;
    }
  }
  return found;
}

/**
 * Whether two steps leave a table the same privileges: the statements that name the table, or a wider
 * object (a schema, `ALL TABLES IN SCHEMA`), are the same in the same order. What a REVOKE does depends on
 * the GRANTs that follow or precede it on the table, so a REVOKE counts as already applied only when all
 * of them are the release's.
 */
export function sameTablePrivileges(release: readonly PrivilegeStatement[], step: readonly PrivilegeStatement[], table: TableName): boolean {
  const forms = (statements: readonly PrivilegeStatement[]): string[] =>
    statements
      .filter((statement) => statement.tables === undefined || statement.tables.some((named) => named.schema === table.schema && named.name === table.name))
      .map((statement) => statement.form);
  const before = forms(release);
  const after = forms(step);
  return before.length === after.length && before.every((form, index) => form === after[index]);
}

/**
 * The statements of the latest custom-SQL step of the release, read from git at the tag: what a migration of the
 * release ran for src/sql/, which a later step, re-emitting all of src/sql/, runs again. Only the latest step
 * counts: it re-emits every file, so a statement an earlier step ran and the latest left out is no longer one of
 * the release's.
 *
 * Undefined when the release has no custom step, and when its step cannot be read: nothing is then shown
 * to be applied by the release, and every statement stays judged on its own. A file of the journal that git
 * cannot show at the tag is an error.
 */
export function readReleasedStep(packageDir: string, release: ReleaseState): AnalysedStatement[] | undefined {
  const prefix = git(packageDir, ["rev-parse", "--show-prefix"]).trim();
  for (const migration of [...release.migrations].reverse()) {
    const sql = showAtTag(packageDir, prefix, release.tag, `migrations/${migration}.sql`);
    try {
      const step = customStep(sql);
      if (step !== undefined) {
        return step;
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** The table-privilege statements (see `privilegeStatements`) of the latest custom-SQL step of the release (see `readReleasedStep`). */
export function readReleasedPrivileges(packageDir: string, release: ReleaseState): PrivilegeStatement[] | undefined {
  const step = readReleasedStep(packageDir, release);
  return step === undefined ? undefined : privilegeStatements(step);
}

/** A GRANT or REVOKE of a step that can change who may run a function: on one function, or on a wider object (`fn` undefined). */
export interface FunctionPrivilege {
  /** The statement in the form `statementForm` gives. */
  form: string;
  fn: FunctionIdentity | undefined;
}

/** Whether a function is named with printable ASCII and within the 63 bytes PostgreSQL keeps, so that its name is compared as PostgreSQL compares it. */
function comparable({ name }: FunctionIdentity): boolean {
  return [name.schema, name.name].every((part) => /^[\x20-\x7e]*$/.test(part) && Buffer.byteLength(part) <= 63);
}

/**
 * The GRANT and REVOKE statements of a step in order that can change who may run a function: those on one
 * function (EXECUTE to slugbase_app, ALL from PUBLIC, and a REVOKE read by its whole shape) and those on a
 * wider object (a schema, `ALL FUNCTIONS IN SCHEMA`, a sequence, a database). A statement on tables, and the
 * GRANT and REVOKE of CREATE on a schema, cannot.
 *
 * Undefined when a GRANT or REVOKE of the step is one the reader does not place, or names a function the
 * rule does not compare by name, since the step then does not show what it leaves a function's privileges as.
 */
export function functionPrivilegeStatements(step: readonly AnalysedStatement[]): FunctionPrivilege[] | undefined {
  const found: FunctionPrivilege[] = [];
  for (const statement of step) {
    if (!/^(grant|revoke)\b/i.test(statement.text.trim())) {
      continue;
    }
    const form = statementForm(statement);
    const [operation, ...rest] = statement.operations;
    const fn = rest.length === 0 && operation !== undefined ? (operation.kind === "grants-function-execute" || operation.kind === "revokes-function-public" ? operation.fn : functionStatementOf(statement)?.fn) : undefined;
    if (fn !== undefined) {
      if (!comparable(fn)) {
        return undefined;
      }
      found.push({ form, fn });
    } else if (rest.length === 0 && (operation?.kind === "grants-schema-create" || operation?.kind === "revokes-schema-create")) {
      continue;
    } else if (rest.length === 0 && operation?.kind === "revoke") {
      if (operation.tables === undefined) {
        found.push({ form, fn: undefined });
      }
    } else {
      const object = grantObject(statement);
      if (object === undefined) {
        return undefined;
      }
      if (object.tables === undefined) {
        found.push({ form, fn: undefined });
      }
    }
  }
  return found;
}

/**
 * Whether two steps leave the functions of a name the same privileges: the statements that name a function of
 * that name (whatever its argument types), or a wider object, are the same in the same order. What a REVOKE
 * does depends on the GRANT statements that follow or precede it, so a REVOKE counts as already run only when
 * all of them are the earlier step's.
 */
export function sameFunctionPrivileges(before: readonly FunctionPrivilege[], after: readonly FunctionPrivilege[], fn: FunctionIdentity): boolean {
  const forms = (statements: readonly FunctionPrivilege[]): string[] =>
    statements.filter((statement) => statement.fn === undefined || functionNameKey(statement.fn) === functionNameKey(fn)).map((statement) => statement.form);
  const earlier = forms(before);
  const later = forms(after);
  return earlier.length === later.length && earlier.every((form, index) => form === later[index]);
}
