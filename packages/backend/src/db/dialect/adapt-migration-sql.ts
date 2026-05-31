/**
 * Adapts Drizzle Kit SQLite migration SQL for Postgres execution.
 * The shared migration history is generated from the SQLite dialect; Postgres
 * rejects backtick identifiers but accepts double-quoted identifiers.
 * SQLite `integer` columns holding epoch-ms timestamps are widened to `bigint`
 * because Postgres `integer` is 32-bit.
 */
export function adaptSqliteMigrationSqlForPostgres(sql: string): string {
  return sql
    .replace(/`([^`]+)`/g, '"$1"')
    .replace(/"updated_at"\s+integer/gi, '"updated_at" bigint');
}
