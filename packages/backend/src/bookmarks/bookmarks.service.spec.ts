import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import type { WorkspaceRecord } from "../workspaces/workspace.types.js";
import { EMPTY_WORKSPACE_BILLING } from "../workspaces/workspace.types.js";
import { BookmarksService } from "./bookmarks.service.js";

function makeWorkspace(overrides: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
  return {
    id: "ws-1",
    name: "Test",
    slug: "test",
    plan: "personal",
    planSeats: null,
    planArchived: false,
    ...EMPTY_WORKSPACE_BILLING,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function createService(): BookmarksService {
  const db = { getOrm: vi.fn(() => ({})) };
  const wsDataGuard = { verifyOwnership: vi.fn((_wsId: string, bookmark: unknown) => bookmark) };
  const entitlements = { assertCanCreateBookmark: vi.fn() };
  const authz = {};
  const moduleRef = { get: vi.fn() };
  const sharingSummary = { assembleForBookmarkList: vi.fn(() => Promise.resolve(new Map())) };

  return new BookmarksService(
    db as never,
    wsDataGuard as never,
    entitlements as never,
    authz as never,
    moduleRef as never,
    sharingSummary as never,
  );
}

describe("BookmarksService URL validation", () => {
  const service = createService();
  const workspace = makeWorkspace();

  it.each([
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "//evil.example.com",
  ])("rejects non-http(s) URL %s on create", async (url) => {
    await expect(
      service.createBookmark(workspace, "user-1", {
        title: "Test",
        url,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
