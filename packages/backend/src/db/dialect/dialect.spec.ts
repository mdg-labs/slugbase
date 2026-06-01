import { describe, expect, it } from "vitest";

import { assertPostgresDatabaseUrl } from "./dialect.js";

describe("assertPostgresDatabaseUrl", () => {
  it("accepts postgres URLs", () => {
    expect(() => {
      assertPostgresDatabaseUrl("postgres://user:pass@localhost/db");
    }).not.toThrow();
    expect(() => {
      assertPostgresDatabaseUrl("postgresql://user:pass@localhost/db");
    }).not.toThrow();
  });

  it("rejects sqlite URLs with deferred message", () => {
    expect(() => {
      assertPostgresDatabaseUrl("sqlite://./dev.db");
    }).toThrow(/SQLite support is deferred/);
    expect(() => {
      assertPostgresDatabaseUrl("file:./dev.db");
    }).toThrow(/SQLite support is deferred/);
  });

  it("rejects unsupported schemes", () => {
    expect(() => {
      assertPostgresDatabaseUrl("mysql://localhost/db");
    }).toThrow(/Unsupported DATABASE_URL scheme/);
  });
});
