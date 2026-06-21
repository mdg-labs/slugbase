import { getTableColumns } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { adminTables } from "../schema/index.js";

describe("admin schema exports", () => {
  it("defines all five admin tables per admin PRD §7", () => {
    expect(Object.keys(adminTables).sort()).toEqual([
      "adminInvites",
      "adminSessions",
      "adminUsers",
      "auditEvents",
      "dailySnapshots",
    ]);
  });

  it("uses the admin Postgres schema for every table", () => {
    for (const table of Object.values(adminTables)) {
      expect(getTableConfig(table).schema).toBe("admin");
    }
  });

  it("daily_snapshots includes snapshot_date and workspaces_by_plan", () => {
    const columns = getTableColumns(adminTables.dailySnapshots);
    expect(columns.snapshotDate.name).toBe("snapshot_date");
    expect(columns.workspacesByPlan.name).toBe("workspaces_by_plan");
  });

  it("admin_users stores role and password_hash", () => {
    const columns = getTableColumns(adminTables.adminUsers);
    expect(columns.role.name).toBe("role");
    expect(columns.passwordHash.name).toBe("password_hash");
  });
});
