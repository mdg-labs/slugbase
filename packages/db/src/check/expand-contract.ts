import { analyseSql, setsSessionTimeout, type Operation, type TableName } from "./migration-statements.ts";
import { readJournal, readMigration } from "./migration-files.ts";
import { readReleaseState, releaseTags, type ReleaseState } from "./release-history.ts";
import type { CheckRule, Finding } from "./types.ts";

// Doc 05 section 5.2 and Q52: several replicas run during a rolling deploy, so a
// migration must work for the code before it and after it. Every migration
// added since the latest release tag is read, and the rule rejects in it:
//
//   - dropping or renaming a table or column that exists at that tag (also
//     moving a table to another schema, or dropping a schema that holds one),
//   - adding a NOT NULL column without a default to a table that exists at it,
//   - changing the type of a column of such a table (any change: whether it
//     rewrites the table depends on the old and the new type, which a lint of
//     the file cannot tell),
//   - creating an index on such a table without CONCURRENTLY,
//   - any statement this check does not positively read as one of the forms it
//     lists as safe (CREATE TABLE of a column list and nothing after it,
//     CREATE INDEX/POLICY/EXTENSION/SEQUENCE/SCHEMA, an enum CREATE TYPE, a
//     LANGUAGE sql CREATE FUNCTION of one SELECT of
//     built-ins, ALTER TABLE actions, DROP INDEX/POLICY, GRANT/REVOKE/COMMENT),
//     or that calls a function outside a short list of built-ins and the
//     tenant context functions. Everything else (DO, CALL, COPY, SELECT, SET,
//     INSERT/UPDATE/DELETE, other ALTER/DROP/CREATE forms, ...) could hold any
//     of the above.
//
// Those are accepted only in the contract half of an expand/contract pair, and
// only with both of:
//
//   - a header in the leading comment block of the file,
//       -- slugbase:contract expand=<migration tag> release=<version>
//     where <migration tag> is a migration of the journal that the release
//     <version> already contained, and <version> is a release tag. The expand
//     migration has therefore shipped in a release before the one that
//     carries this file (Q52).
//   - the contract marker: SLUGBASE_DB_CHECK_CONTRACT=true in the environment
//     of `pnpm db:check`. CI sets it when the pull request carries the
//     maintainer-applied `migration:contract` label. It is read by the check
//     only and is not a product environment variable (D24), like
//     SLUGBASE_TEST_PG_URL.
//
// Either alone is rejected. A file that sets lock_timeout or statement_timeout
// is rejected whatever its header says: `migrate` sets both for its session
// (5 s and 15 min, and lock_timeout off for a CONCURRENTLY step), and a
// migration changes neither.
//
// The tables and columns "at the tag" come from the snapshot of the tag's last
// migration, so objects that only custom SQL creates (functions, policies) are
// not part of it. Without a release tag in a full clone every object counts as
// unreleased. Without a way to tell (a shallow clone, no git) the rule fails;
// see release-history.ts.

const ID = "expand-contract";
const MARKER_VARIABLE = "SLUGBASE_DB_CHECK_CONTRACT";
const HEADER_PREFIX = "-- slugbase:contract";
const HEADER = /^-- slugbase:contract expand=(\S+) release=(\S+)\s*$/;
const HEADER_SYNTAX = `${HEADER_PREFIX} expand=<migration tag> release=<version>`;

/** Whether the environment carries the contract marker. Only the exact value `true` does. */
export function contractMarkerFromEnv(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[MARKER_VARIABLE] === "true";
}

const key = (table: TableName): string => `${table.schema}.${table.name}`;

function describe(table: TableName): string {
  return table.schema === "public" ? table.name : key(table);
}

/** The tables and columns of the release, which the added migrations change as they go. */
class Released {
  private readonly tables = new Map<string, Set<string>>();

  readonly tag: string | undefined;

  constructor(tag: string | undefined, state: ReleaseState | undefined) {
    this.tag = tag;
    for (const table of state?.tables ?? []) {
      this.tables.set(key(table), new Set(table.columns));
    }
  }

  hasTable(table: TableName): boolean {
    return this.tables.has(key(table));
  }

  hasColumn(table: TableName, column: string): boolean {
    return this.tables.get(key(table))?.has(column) === true;
  }

  apply(operation: Operation): string[] {
    const at = this.tag ?? "the latest release";
    switch (operation.kind) {
      case "drop-table": {
        if (!this.hasTable(operation.table)) {
          return [];
        }
        this.tables.delete(key(operation.table));
        return [(`drops table ${describe(operation.table)}, which exists at ${at}: the previous release still reads it during a rolling deploy`)];
      }
      case "drop-schema": {
        const dropped = [...this.tables.keys()].filter((name) => name.startsWith(`${operation.schema}.`));
        for (const name of dropped) {
          this.tables.delete(name);
        }
        return dropped.map((name) => (`drops schema ${operation.schema}, which holds table ${name} that exists at ${at}`));
      }
      case "drop-column": {
        if (!this.hasColumn(operation.table, operation.column)) {
          return [];
        }
        this.tables.get(key(operation.table))?.delete(operation.column);
        return [(`drops column ${describe(operation.table)}.${operation.column}, which exists at ${at}: the previous release still reads it during a rolling deploy`)];
      }
      case "rename-table":
      case "set-schema": {
        const columns = this.tables.get(key(operation.table));
        if (columns === undefined) {
          return [];
        }
        this.tables.delete(key(operation.table));
        this.tables.set(key(operation.to), columns);
        const verb = operation.kind === "rename-table" ? "renames" : "moves";
        return [(`${verb} table ${describe(operation.table)} to ${describe(operation.to)}, and it exists under its old name at ${at}`)];
      }
      case "rename-column": {
        const columns = this.tables.get(key(operation.table));
        if (columns?.has(operation.column) !== true) {
          return [];
        }
        columns.delete(operation.column);
        columns.add(operation.to);
        return [(`renames column ${describe(operation.table)}.${operation.column} to ${operation.to}, and it exists under its old name at ${at}`)];
      }
      case "add-column":
        return operation.notNullWithoutDefault && this.hasTable(operation.table)
          ? [(`adds column ${describe(operation.table)}.${operation.column} as NOT NULL without a default to a table that exists at ${at}: the previous release does not write it`)]
          : [];
      case "alter-column-type":
        return this.hasTable(operation.table)
          ? [(`changes the type of column ${describe(operation.table)}.${operation.column} of a table that exists at ${at}: that can rewrite the table under an ACCESS EXCLUSIVE lock`)]
          : [];
      case "create-index":
        return !operation.concurrently && this.hasTable(operation.table)
          ? [(`creates an index on table ${describe(operation.table)}, which exists at ${at}, without CONCURRENTLY`)]
          : [];
      case "unknown":
        return [(`has a statement this check cannot place (${operation.reason}), so it cannot show that the statement keeps the previous release working`)];
      case "safe":
        return [];
    }
  }
}

/** The `-- slugbase:contract` lines in the leading comment block of a file. */
function headerLines(content: string): string[] {
  const lines: string[] = [];
  for (const raw of content.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (line === "") {
      continue;
    }
    if (!line.startsWith("--")) {
      break;
    }
    if (line.startsWith(HEADER_PREFIX)) {
      lines.push(line);
    }
  }
  return lines;
}

/** What is wrong with the contract header of a file, or undefined when it is valid. */
function headerProblem(packageDir: string, content: string, tags: readonly string[], journalTags: ReadonlySet<string>): string | undefined {
  const lines = headerLines(content);
  if (lines.length === 0) {
    return `has no contract header (${HEADER_SYNTAX}) naming the expand migration and the release it pairs with`;
  }
  const match = lines.length === 1 ? HEADER.exec(lines[0] ?? "") : null;
  if (match === null) {
    return `has a malformed contract header (expected exactly one line: ${HEADER_SYNTAX})`;
  }
  const expand = match[1] ?? "";
  const version = (match[2] ?? "").replace(/^v/, "");
  if (!journalTags.has(expand)) {
    return `has a contract header naming ${expand}, which is not a migration of the journal`;
  }
  const tag = tags.find((candidate) => candidate.replace(/^v/, "") === version);
  if (tag === undefined) {
    return `has a contract header naming release ${version}, which is not a release tag of this repository`;
  }
  if (!readReleaseState(packageDir, tag).migrations.includes(expand)) {
    return `has a contract header pairing it with ${expand} in release ${version}, but ${expand} is not part of that release`;
  }
  return undefined;
}

export const expandContractRule: CheckRule = {
  id: ID,
  description:
    "migrations added since the latest release tag do not drop, rename or rewrite what the release holds, unless they are the marked contract half of an expand/contract pair",
  // eslint-disable-next-line @typescript-eslint/require-await -- git is read synchronously; the rule contract allows a promise
  async run({ packageDir, contractMarker }) {
    const journal = readJournal(packageDir);
    const journalTags = new Set(journal.map(({ tag }) => tag));
    const tags = releaseTags(packageDir);
    const latest = tags.at(-1);
    const release = latest === undefined ? undefined : readReleaseState(packageDir, latest);
    const released = new Released(latest, release);
    const shipped = new Set(release?.migrations);
    const findings: Finding[] = [];

    for (const { tag } of journal) {
      if (shipped.has(tag)) {
        continue;
      }
      const object = `migrations/${tag}.sql`;
      const content = readMigration(packageDir, tag);
      if (content === undefined) {
        throw new Error(`migration file ${tag}.sql listed in the journal cannot be read`);
      }
      const problems: string[] = [];
      try {
        const timeout = setsSessionTimeout(content);
        if (timeout !== undefined) {
          findings.push({
            rule: ID,
            object,
            message: `sets ${timeout}: \`migrate\` sets lock_timeout and statement_timeout for its session (doc 05 section 5.2), a migration file does not`,
          });
        }
        for (const statement of analyseSql(content)) {
          for (const operation of statement.operations) {
            problems.push(...released.apply(operation));
          }
        }
      } catch (error) {
        problems.push(
          `cannot be read by this check (${error instanceof Error ? error.message : "unknown error"}), so it cannot show that the file keeps the previous release working`,
        );
      }
      if (problems.length === 0) {
        continue;
      }
      const header = headerProblem(packageDir, content, tags, journalTags);
      const marked = contractMarker === true;
      let needs: string | undefined;
      if (header !== undefined && !marked) {
        needs = `it is not accepted: it ${header}, and the contract marker is not set (${MARKER_VARIABLE}=true, which CI sets for a pull request labelled migration:contract)`;
      } else if (header !== undefined) {
        needs = `it is not accepted: it ${header}`;
      } else if (!marked) {
        needs = `it is not accepted: the contract marker is not set (${MARKER_VARIABLE}=true, which CI sets for a pull request labelled migration:contract)`;
      }
      if (needs === undefined) {
        continue;
      }
      for (const found of problems) {
        findings.push({ rule: ID, object, message: `${found}; ${needs}` });
      }
    }
    return findings;
  },
};
