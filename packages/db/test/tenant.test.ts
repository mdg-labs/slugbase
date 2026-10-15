import { pgTable, text, uuid } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import * as entry from "../src/index.ts";
import { listRepositoryMethods } from "../src/repositories/registry.ts";
import { defineScopedRepository } from "../src/repositories/scoped.ts";
import { bindTenantDatabase, TenantContextError } from "../src/tenant.ts";

// withTenant validates before it touches the database, and a repository is
// only defined over a table that has a workspace column. Nothing here connects:
// the client points at a closed port, so any SQL would surface as a connection
// error rather than the TenantContextError the tests expect.

const ACCOUNT = "0192f3a0-0000-7000-8000-00000000000a";
const WORKSPACE = "0192f3a0-1111-7000-8000-00000000000a";

const unreachable = postgres({ host: "127.0.0.1", port: 1, database: "none", username: "none", max: 1 });
const { withTenant } = bindTenantDatabase(unreachable);

const never = () => Promise.reject(new Error("the callback must not run"));

describe("withTenant rejects before any SQL", () => {
  const cases: [string, Parameters<typeof withTenant>[0], string][] = [
    ["an account id that is not a UUID", { accountId: "not-a-uuid", requestId: "r" }, "invalid_account_id"],
    ["an empty account id", { accountId: "", requestId: "r" }, "invalid_account_id"],
    ["an account id with a SQL fragment", { accountId: `${ACCOUNT}'; --`, requestId: "r" }, "invalid_account_id"],
    ["a workspace id that is not a UUID", { accountId: ACCOUNT, workspaceId: "42", requestId: "r" }, "invalid_workspace_id"],
    ["an empty workspace id", { accountId: ACCOUNT, workspaceId: "", requestId: "r" }, "invalid_workspace_id"],
    ["an empty request id", { accountId: ACCOUNT, workspaceId: WORKSPACE, requestId: "" }, "invalid_request_id"],
    ["a request id with a line break", { accountId: ACCOUNT, requestId: "a\nb" }, "invalid_request_id"],
    ["a request id longer than 128 characters", { accountId: ACCOUNT, requestId: "x".repeat(129) }, "invalid_request_id"],
  ];
  it.each(cases)("%s", async (_label, context, code) => {
    await expect(withTenant(context, never)).rejects.toMatchObject({ name: "TenantContextError", code });
  });

  it("reaches the database for a valid context (the control of the cases above)", async () => {
    const error = await withTenant({ accountId: ACCOUNT, requestId: "r" }, () => Promise.resolve()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TenantContextError);
  });
});

describe("defineScopedRepository", () => {
  it("refuses a table without a workspace_id column", () => {
    const loose = pgTable("loose", { id: uuid("id").primaryKey(), workspaceId: text("owner_ref") });
    expect(() => defineScopedRepository("loose-repo", loose)).toThrow(/no NOT NULL workspace_id column/);
    expect(listRepositoryMethods().some((e) => e.repository === "loose-repo")).toBe(false);
  });

  it("refuses a nullable workspace_id column", () => {
    const nullable = pgTable("nullable", { id: uuid("id").primaryKey(), workspaceId: uuid("workspace_id") });
    expect(() => defineScopedRepository("nullable-repo", nullable)).toThrow(/NOT NULL workspace_id/);
  });

  it("refuses a second repository of the same name", () => {
    const table = pgTable("dup", { id: uuid("id").primaryKey(), workspaceId: uuid("workspace_id").notNull() });
    defineScopedRepository("dup-repo", table);
    expect(() => defineScopedRepository("dup-repo", table)).toThrow(/already defined/);
    expect(listRepositoryMethods().filter((e) => e.repository === "dup-repo")).toHaveLength(4);
  });
});

describe("the package entry point", () => {
  it("exports withTenant through createDatabase, the repository helper, the account repositories and the rate-limit store, and no raw handle", () => {
    expect(Object.keys(entry).sort()).toEqual(
      [
        "ACCENT_PRESETS",
        "CE_CHAIN",
        "ConnectionRoleError",
        "MigrationError",
        "TenantContextError",
        "accountIdentityRepository",
        "accountProfileRepository",
        "apiTokenRepository",
        "connectionRole",
        "createAuthStore",
        "createDatabase",
        "createRateLimitStore",
        "createRetentionStore",
        "defineScopedRepository",
        "listRepositoryMethods",
        "membershipRepository",
        "migrate",
        "migrationLevel",
      ].sort(),
    );
    const database = entry.createDatabase({ url: "postgres://u:p@127.0.0.1:1/none", poolSize: 1 });
    expect(Object.keys(database).sort()).toEqual(["close", "withTenant"]);
    return database.close();
  });
});
