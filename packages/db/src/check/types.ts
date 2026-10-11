import type postgres from "postgres";

// The rules behind `pnpm db:check` (doc 08 section 3.4, doc 05 section 5.1). A
// rule inspects a freshly migrated database, the migrations folder or both, and
// returns one finding per object that breaks it. Later rules (the SECURITY
// DEFINER registry, the expand/contract header) are added to `checkRules` in
// ./index.ts.

export interface Finding {
  /** The id of the rule that found it. */
  rule: string;
  /** What is wrong: a table, a migration file, a role-owned object. Always names it. */
  object: string;
  message: string;
}

export interface CheckContext {
  /** The `packages/db` directory the rules inspect: `migrations/`, `src/schema/`, `src/sql/`. */
  packageDir: string;
  /** A connection to a freshly migrated database, absent when none could be made. */
  sql: postgres.Sql | undefined;
  /** Hash of the `src/sql/` files, as the generator records it (scripts/migration-sql.ts). */
  hashSqlFiles: (files: readonly { name: string; content: string }[]) => string;
}

export interface CheckRule {
  id: string;
  description: string;
  run(context: CheckContext): readonly Finding[] | Promise<readonly Finding[]>;
}

export interface RuleResult {
  rule: string;
  description: string;
  findings: readonly Finding[];
}

/** The connection of a rule that reads the database; a context without one is an error, never a pass. */
export function requireDatabase(context: CheckContext): postgres.Sql {
  if (context.sql === undefined) {
    throw new Error("no database connection: the freshly migrated database could not be built");
  }
  return context.sql;
}
