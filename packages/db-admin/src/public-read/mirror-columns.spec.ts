import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { PgColumn } from "drizzle-orm/pg-core";
import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  MIRROR_ALLOWLIST,
  MIRROR_TABLE_NAMES,
  publicReadTables,
  type MirrorTableName,
} from "./index.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

const BACKEND_SCHEMA_DIR = path.join(
  repoRoot,
  "packages/backend/src/db/schema",
);

const BACKEND_SCHEMA_FILES: Record<keyof typeof MIRROR_ALLOWLIST, string> = {
  user_accounts: "user-account.schema.ts",
  workspaces: "workspace.schema.ts",
  workspace_members: "workspace-member.schema.ts",
  bookmarks: "bookmark.schema.ts",
  folders: "folder.schema.ts",
  tags: "tag.schema.ts",
  teams: "team.schema.ts",
  team_memberships: "team-membership.schema.ts",
  workspace_invitations: "workspace-invitation.schema.ts",
  billing_webhook_events: "billing-webhook-event.schema.ts",
  sessions: "session.schema.ts",
};

const COLUMN_PATTERN =
  /(?:text|bigint|boolean|integer|uuid|timestamp|date|jsonb)\(\s*"([a-z_]+)"\s*(?:,|\))/g;

function extractBackendColumnNames(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(COLUMN_PATTERN)) {
    const name = match[1];
    if (name) {
      names.add(name);
    }
  }
  return [...names];
}

function mirrorColumnNames(tableName: MirrorTableName): string[] {
  const table = publicReadTables[tableName];
  const columns = getTableColumns(table) as Record<string, PgColumn>;
  return Object.values(columns).map((column) => column.name);
}

describe("public-read mirror allowlist (admin PRD §8.5)", () => {
  it("mirrors every allowlisted table", () => {
    expect(Object.keys(publicReadTables).sort()).toEqual([...MIRROR_TABLE_NAMES].sort());
  });

  it.each(MIRROR_TABLE_NAMES)(
    "%s mirror column names match backend for allowlisted fields",
    async (tableName) => {
      const schemaPath = path.join(BACKEND_SCHEMA_DIR, BACKEND_SCHEMA_FILES[tableName]);
      const source = await readFile(schemaPath, "utf8");
      const backendNames = extractBackendColumnNames(source);
      const allowlisted = MIRROR_ALLOWLIST[tableName];
      const mirrorNames = mirrorColumnNames(tableName);

      expect(mirrorNames.sort()).toEqual([...allowlisted].sort());

      for (const column of allowlisted) {
        expect(backendNames).toContain(column);
      }
    },
  );
});

describe("public-read package constraints", () => {
  it("does not import @slugbase/backend in public-read sources", async () => {
    const publicReadDir = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
    );
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(publicReadDir);
    const sourceFiles = entries.filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".spec.ts"),
    );

    for (const file of sourceFiles) {
      const content = await readFile(path.join(publicReadDir, file), "utf8");
      expect(content).not.toMatch(/@slugbase\/backend/);
    }
  });
});
