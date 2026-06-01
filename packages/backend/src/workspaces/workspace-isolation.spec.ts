import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { describe, expect, it } from "vitest";

import type { DrizzleClient } from "../db/dialect/create-client.js";
import {
  WorkspaceScopedRepository,
  type WorkspaceOwned,
} from "../db/workspace-scoped.repository.js";
import { assertResourceOwnership } from "./resource-ownership.js";
import { WorkspaceDataGuard } from "./workspace-data.guard.js";

// ---------------------------------------------------------------------------
// Test fixture — concrete subclass for testing the abstract base
// ---------------------------------------------------------------------------

interface FakeRecord extends WorkspaceOwned {
  id: string;
  workspaceId: string;
  name: string;
}

/**
 * Concrete test subclass that exposes protected helpers and simulates a
 * minimal scoped repository backed by an in-memory store.
 */
class FakeWorkspaceScopedRepository extends WorkspaceScopedRepository<FakeRecord> {
  private readonly store: FakeRecord[] = [];

  constructor() {
    // Minimal stubs — the base class constructor only stores references
    super({} as DrizzleClient);
  }

  seed(record: FakeRecord): void {
    this.store.push(record);
  }

  /** Simulates a correctly scoped findById — filters + verifies ownership. */
  findByIdScoped(workspaceId: string, id: string): FakeRecord {
    const record = this.store.find((r) => r.id === id && r.workspaceId === workspaceId) ?? null;
    return this.assertOwnership(workspaceId, record);
  }

  /**
   * Simulates a scoped list — filters by workspaceId in the query, then
   * verifies the result set through assertAllOwned.
   */
  listScoped(workspaceId: string): FakeRecord[] {
    const records = this.store.filter((r) => r.workspaceId === workspaceId);
    return this.assertAllOwned(workspaceId, records);
  }

  /**
   * Simulates a mis-scoped query that returns all records without filtering.
   * Used to verify that assertAllOwned catches the leakage.
   */
  listMisscoped(workspaceId: string): FakeRecord[] {
    return this.assertAllOwned(workspaceId, [...this.store]);
  }

  /**
   * Simulates loading a record from a different workspace by ID only
   * (no workspace filter in the query) — verifies assertOwnership catches it.
   */
  findByIdUnscoped(workspaceId: string, id: string): FakeRecord {
    const record = this.store.find((r) => r.id === id) ?? null;
    return this.assertOwnership(workspaceId, record);
  }
}

// ---------------------------------------------------------------------------
// assertResourceOwnership
// ---------------------------------------------------------------------------

describe("assertResourceOwnership", () => {
  it("does not throw when workspace IDs match", () => {
    expect(() => { assertResourceOwnership("ws-1", "ws-1"); }).not.toThrow();
  });

  it("throws ForbiddenException when workspace IDs differ", () => {
    expect(() => { assertResourceOwnership("ws-1", "ws-2"); }).toThrow(
      ForbiddenException,
    );
  });

  it("throws ForbiddenException with a descriptive message", () => {
    expect(() => { assertResourceOwnership("ws-a", "ws-b"); }).toThrow(
      "Resource does not belong to the active workspace",
    );
  });

  it("treats distinct workspace IDs as cross-workspace even with similar names", () => {
    expect(() => { assertResourceOwnership("ws-1", "ws-10"); }).toThrow(
      ForbiddenException,
    );
  });
});

// ---------------------------------------------------------------------------
// WorkspaceDataGuard
// ---------------------------------------------------------------------------

describe("WorkspaceDataGuard", () => {
  const guard = new WorkspaceDataGuard();

  it("returns the resource unchanged when ownership matches", () => {
    const resource: FakeRecord = { id: "r-1", workspaceId: "ws-1", name: "test" };
    const result = guard.verifyOwnership("ws-1", resource);
    expect(result).toBe(resource);
  });

  it("throws ForbiddenException when workspace IDs differ", () => {
    const resource: FakeRecord = { id: "r-1", workspaceId: "ws-2", name: "test" };
    expect(() => guard.verifyOwnership("ws-1", resource)).toThrow(
      ForbiddenException,
    );
  });

  it("throws ForbiddenException with a descriptive message on mismatch", () => {
    const resource: FakeRecord = { id: "r-1", workspaceId: "ws-other", name: "x" };
    expect(() => guard.verifyOwnership("ws-active", resource)).toThrow(
      "Resource does not belong to the active workspace",
    );
  });

  it("works with any object that has a workspaceId field", () => {
    const resource = { workspaceId: "ws-1", someField: 42 };
    expect(guard.verifyOwnership("ws-1", resource)).toBe(resource);
  });
});

// ---------------------------------------------------------------------------
// WorkspaceScopedRepository — assertOwnership (single record)
// ---------------------------------------------------------------------------

describe("WorkspaceScopedRepository — assertOwnership", () => {
  it("returns the record when workspaceId matches", () => {
    const repo = new FakeWorkspaceScopedRepository();
    repo.seed({ id: "r-1", workspaceId: "ws-1", name: "foo" });
    expect(repo.findByIdScoped("ws-1", "r-1")).toMatchObject({ id: "r-1" });
  });

  it("throws NotFoundException when record does not exist", () => {
    const repo = new FakeWorkspaceScopedRepository();
    expect(() => repo.findByIdScoped("ws-1", "non-existent")).toThrow(
      NotFoundException,
    );
  });

  it("throws ForbiddenException when record belongs to a different workspace", () => {
    const repo = new FakeWorkspaceScopedRepository();
    repo.seed({ id: "r-1", workspaceId: "ws-OTHER", name: "intruder" });
    // findByIdUnscoped simulates a mis-scoped DB query that ignores workspace_id
    expect(() => repo.findByIdUnscoped("ws-1", "r-1")).toThrow(
      ForbiddenException,
    );
  });

  it("rejects with ForbiddenException message for cross-workspace access", () => {
    const repo = new FakeWorkspaceScopedRepository();
    repo.seed({ id: "r-1", workspaceId: "ws-2", name: "leaked" });
    expect(() => repo.findByIdUnscoped("ws-1", "r-1")).toThrow(
      "Resource does not belong to the active workspace",
    );
  });
});

// ---------------------------------------------------------------------------
// WorkspaceScopedRepository — assertAllOwned (list)
// ---------------------------------------------------------------------------

describe("WorkspaceScopedRepository — assertAllOwned", () => {
  it("returns all records when all belong to the workspace", () => {
    const repo = new FakeWorkspaceScopedRepository();
    repo.seed({ id: "r-1", workspaceId: "ws-1", name: "a" });
    repo.seed({ id: "r-2", workspaceId: "ws-1", name: "b" });
    const results = repo.listScoped("ws-1");
    expect(results).toHaveLength(2);
  });

  it("returns empty array when workspace has no records", () => {
    const repo = new FakeWorkspaceScopedRepository();
    repo.seed({ id: "r-1", workspaceId: "ws-2", name: "other" });
    expect(repo.listScoped("ws-1")).toHaveLength(0);
  });

  it("throws ForbiddenException when a cross-workspace record slips through", () => {
    const repo = new FakeWorkspaceScopedRepository();
    repo.seed({ id: "r-1", workspaceId: "ws-1", name: "ok" });
    repo.seed({ id: "r-2", workspaceId: "ws-INTRUDER", name: "bad" });
    // listMisscoped simulates a query that forgot the workspace_id filter
    expect(() => repo.listMisscoped("ws-1")).toThrow(ForbiddenException);
  });

  it("does not return records from a different workspace in a correctly scoped list", () => {
    const repo = new FakeWorkspaceScopedRepository();
    repo.seed({ id: "r-1", workspaceId: "ws-1", name: "mine" });
    repo.seed({ id: "r-2", workspaceId: "ws-2", name: "theirs" });
    const results = repo.listScoped("ws-1");
    expect(results).toHaveLength(1);
    expect(results.every((r) => r.workspaceId === "ws-1")).toBe(true);
  });

  it("isolates workspaces — ws-2 records are not visible to ws-1 queries", () => {
    const repo = new FakeWorkspaceScopedRepository();
    repo.seed({ id: "r-1", workspaceId: "ws-1", name: "ws1-item" });
    repo.seed({ id: "r-2", workspaceId: "ws-2", name: "ws2-item" });
    repo.seed({ id: "r-3", workspaceId: "ws-2", name: "ws2-item-2" });

    expect(repo.listScoped("ws-1")).toHaveLength(1);
    expect(repo.listScoped("ws-2")).toHaveLength(2);
  });
});
