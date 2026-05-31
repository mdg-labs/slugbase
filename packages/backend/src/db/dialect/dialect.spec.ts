import { describe, expect, it } from "vitest";

import {
  parseSqliteFilePath,
  resolveDialect,
} from "./dialect.js";

describe("resolveDialect", () => {
  it("detects sqlite URLs", () => {
    expect(resolveDialect("sqlite://./dev.db")).toBe("sqlite");
    expect(resolveDialect("file:./dev.db")).toBe("sqlite");
  });

  it("detects postgres URLs", () => {
    expect(resolveDialect("postgres://user:pass@localhost/db")).toBe("postgres");
    expect(resolveDialect("postgresql://user:pass@localhost/db")).toBe(
      "postgres",
    );
  });

  it("rejects unsupported schemes", () => {
    expect(() => resolveDialect("mysql://localhost/db")).toThrow(
      /Unsupported DATABASE_URL scheme/,
    );
  });
});

describe("parseSqliteFilePath", () => {
  it("parses relative sqlite URLs", () => {
    expect(parseSqliteFilePath("sqlite://./dev.db")).toBe("./dev.db");
    expect(parseSqliteFilePath("sqlite://dev.db")).toBe("./dev.db");
  });

  it("parses absolute sqlite URLs", () => {
    expect(parseSqliteFilePath("sqlite:///tmp/test.db")).toBe("/tmp/test.db");
  });

  it("parses file URLs", () => {
    expect(parseSqliteFilePath("file:./dev.db")).toBe("./dev.db");
  });
});
