import { describe, expect, it } from "vitest";

import { adaptSqliteMigrationSqlForPostgres } from "./adapt-migration-sql.js";

describe("adaptSqliteMigrationSqlForPostgres", () => {
  it("converts backtick identifiers to double quotes", () => {
    const sqliteSql = "CREATE TABLE `instance_metadata` (\n\t`key` text PRIMARY KEY NOT NULL\n);";

    expect(adaptSqliteMigrationSqlForPostgres(sqliteSql)).toBe(
      'CREATE TABLE "instance_metadata" (\n\t"key" text PRIMARY KEY NOT NULL\n);',
    );
  });

  it("widens epoch-ms integer columns to bigint for Postgres", () => {
    const sqliteSql = "`updated_at` integer NOT NULL";

    expect(adaptSqliteMigrationSqlForPostgres(sqliteSql)).toBe(
      '"updated_at" bigint NOT NULL',
    );
  });
});
