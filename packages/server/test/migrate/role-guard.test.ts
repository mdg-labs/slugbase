import type { ConnectionRole } from "@slugbase/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OwnerConnectionError, assertApplicationRole } from "../../src/migrate/role-guard.ts";
import { recordingLogger } from "../support.ts";

// What the startup check does with each answer of the role inspection (Q56).

const inspected = vi.hoisted(() => ({ result: undefined as undefined | ConnectionRole | Error }));

vi.mock("@slugbase/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@slugbase/db")>();
  return {
    ...actual,
    connectionRole: vi.fn(() => (inspected.result instanceof Error ? Promise.reject(inspected.result) : Promise.resolve(inspected.result))),
  };
});

const URL = "postgres://slugbase_app:Zq8-prod-app-pw@db.internal:5432/slugbase";

beforeEach(() => {
  inspected.result = undefined;
});

describe("assertApplicationRole", () => {
  it("accepts the unprivileged application role without a word", async () => {
    inspected.result = { role: "slugbase_app", superuser: false, ownsDatabase: false };
    const logger = recordingLogger();
    await assertApplicationRole({ url: URL, allowOwnerConnection: false, logger });
    expect(logger.entries).toEqual([]);
  });

  it.each([
    ["a superuser", { role: "postgres", superuser: true, ownsDatabase: false }, "is a superuser"],
    ["the owner of the database", { role: "appowner", superuser: false, ownsDatabase: true }, "owns the database"],
    ["a superuser that owns the database", { role: "postgres", superuser: true, ownsDatabase: true }, "is a superuser and owns the database"],
  ] as const)("refuses %s, explaining the two roles", async (_label, role, reason) => {
    inspected.result = role;
    const logger = recordingLogger();
    const failure = await assertApplicationRole({ url: URL, allowOwnerConnection: false, logger }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(OwnerConnectionError);
    const message = (failure as Error).message;
    expect(message).toContain(reason);
    expect(message).toContain("slugbase_app");
    expect(message).toContain("slugbase_migrator");
    expect(message).toContain("SLUGBASE_ALLOW_OWNER_CONNECTION=true");
    expect(message).not.toContain(URL);
    expect(logger.entries).toEqual([]);
  });

  it("warns instead of refusing when the operator allows it", async () => {
    inspected.result = { role: "appowner", superuser: false, ownsDatabase: true };
    const logger = recordingLogger();
    await assertApplicationRole({ url: URL, allowOwnerConnection: true, logger });
    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]).toMatchObject({ level: "warn", fields: { role: "appowner", ownsDatabase: true } });
  });

  it("does not warn when the override is set but the role is unprivileged", async () => {
    inspected.result = { role: "slugbase_app", superuser: false, ownsDatabase: false };
    const logger = recordingLogger();
    await assertApplicationRole({ url: URL, allowOwnerConnection: true, logger });
    expect(logger.entries).toEqual([]);
  });

  it("rejects when the role cannot be read, whatever the override says", async () => {
    inspected.result = new Error("the database is unreachable");
    await expect(assertApplicationRole({ url: URL, allowOwnerConnection: true, logger: recordingLogger() })).rejects.toThrow(
      "the database is unreachable",
    );
  });
});
