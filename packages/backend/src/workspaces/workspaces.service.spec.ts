import { ConflictException, ForbiddenException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import type { WorkspaceMemberRepository } from "./workspace-member.repository.js";
import type { WorkspaceRepository } from "./workspace.repository.js";
import {
  ROLE_HIERARCHY,
  type WorkspaceMemberRecord,
  type WorkspaceMemberRole,
  type WorkspaceRecord,
} from "./workspace.types.js";
import { EMPTY_WORKSPACE_BILLING } from "./workspace.types.js";

interface ServiceInternals {
  workspaceRepo: WorkspaceRepository;
  memberRepo: WorkspaceMemberRepository;
}

describe("ROLE_HIERARCHY", () => {
  it("OWNER has higher rank than ADMIN", () => {
    expect(ROLE_HIERARCHY["OWNER"]).toBeGreaterThan(ROLE_HIERARCHY["ADMIN"]);
  });

  it("ADMIN has higher rank than MEMBER", () => {
    expect(ROLE_HIERARCHY["ADMIN"]).toBeGreaterThan(ROLE_HIERARCHY["MEMBER"]);
  });

  it("OWNER has higher rank than MEMBER", () => {
    expect(ROLE_HIERARCHY["OWNER"]).toBeGreaterThan(ROLE_HIERARCHY["MEMBER"]);
  });

  it("each role maps to a distinct integer", () => {
    const values = Object.values(ROLE_HIERARCHY);
    expect(new Set(values).size).toBe(values.length);
  });
});

function makeWorkspace(overrides: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
  return {
    id: "ws-1",
    name: "Test Workspace",
    slug: "test-workspace",
    plan: "free",
    planSeats: null,
    planArchived: false,
    ...EMPTY_WORKSPACE_BILLING,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeMember(
  workspaceId: string,
  userId: string,
  role: WorkspaceMemberRole,
): WorkspaceMemberRecord {
  return {
    id: `member-${userId}`,
    workspaceId,
    userId,
    role,
    joinedAt: new Date(),
  };
}

describe("WorkspacesService — slug uniqueness", () => {
  it("createWorkspace rejects a duplicate slug", async () => {
    const { WorkspacesService } = await import("./workspaces.service.js");

    const existingWorkspace = makeWorkspace({ slug: "taken-slug" });
    const mockDb = { getOrm: () => ({}), dialect: "sqlite" as const };

    const service = new WorkspacesService(mockDb as never);
    const internals = service as unknown as ServiceInternals;

    vi.spyOn(internals.workspaceRepo, "findBySlug").mockResolvedValue(existingWorkspace);

    await expect(
      service.createWorkspace({ name: "Other", slug: "taken-slug" }, "user-1"),
    ).rejects.toThrow(ConflictException);
  });

  it("createWorkspace succeeds with a unique slug", async () => {
    const { WorkspacesService } = await import("./workspaces.service.js");

    const newWorkspace = makeWorkspace({ slug: "new-slug" });
    const mockDb = { getOrm: () => ({}), dialect: "sqlite" as const };

    const service = new WorkspacesService(mockDb as never);
    const internals = service as unknown as ServiceInternals;

    vi.spyOn(internals.workspaceRepo, "findBySlug").mockResolvedValue(null);
    vi.spyOn(internals.workspaceRepo, "create").mockResolvedValue(newWorkspace);
    vi.spyOn(internals.memberRepo, "create").mockResolvedValue(
      makeMember(newWorkspace.id, "user-1", "OWNER"),
    );

    const result = await service.createWorkspace(
      { name: "New", slug: "new-slug" },
      "user-1",
    );
    expect(result.slug).toBe("new-slug");
  });
});

describe("WorkspacesService — role checks", () => {
  it("requireWorkspaceRole throws ForbiddenException when user is not a member", async () => {
    const { WorkspacesService } = await import("./workspaces.service.js");

    const mockDb = { getOrm: () => ({}), dialect: "sqlite" as const };
    const service = new WorkspacesService(mockDb as never);
    const internals = service as unknown as ServiceInternals;

    vi.spyOn(internals.memberRepo, "findByWorkspaceAndUser").mockResolvedValue(null);

    await expect(
      service.requireWorkspaceRole("ws-1", "user-x", "MEMBER"),
    ).rejects.toThrow(ForbiddenException);
  });

  it("requireWorkspaceRole throws ForbiddenException when MEMBER requires ADMIN", async () => {
    const { WorkspacesService } = await import("./workspaces.service.js");

    const mockDb = { getOrm: () => ({}), dialect: "sqlite" as const };
    const service = new WorkspacesService(mockDb as never);
    const internals = service as unknown as ServiceInternals;

    vi.spyOn(internals.memberRepo, "findByWorkspaceAndUser").mockResolvedValue(
      makeMember("ws-1", "user-1", "MEMBER"),
    );

    await expect(
      service.requireWorkspaceRole("ws-1", "user-1", "ADMIN"),
    ).rejects.toThrow(ForbiddenException);
  });

  it("requireWorkspaceRole passes when OWNER satisfies OWNER requirement", async () => {
    const { WorkspacesService } = await import("./workspaces.service.js");

    const mockDb = { getOrm: () => ({}), dialect: "sqlite" as const };
    const service = new WorkspacesService(mockDb as never);
    const internals = service as unknown as ServiceInternals;

    vi.spyOn(internals.memberRepo, "findByWorkspaceAndUser").mockResolvedValue(
      makeMember("ws-1", "user-1", "OWNER"),
    );

    await expect(
      service.requireWorkspaceRole("ws-1", "user-1", "OWNER"),
    ).resolves.toBeUndefined();
  });

  it("deleteWorkspace requires OWNER role", async () => {
    const { WorkspacesService } = await import("./workspaces.service.js");

    const mockDb = { getOrm: () => ({}), dialect: "sqlite" as const };
    const service = new WorkspacesService(mockDb as never);
    const internals = service as unknown as ServiceInternals;

    vi.spyOn(internals.memberRepo, "findByWorkspaceAndUser").mockResolvedValue(
      makeMember("ws-1", "user-admin", "ADMIN"),
    );

    await expect(
      service.deleteWorkspace("ws-1", "user-admin"),
    ).rejects.toThrow(ForbiddenException);
  });
});
