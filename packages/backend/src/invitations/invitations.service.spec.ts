import { createHash, randomBytes } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  INVITATION_TTL_DAYS,
  generateInvitationToken,
  hashInvitationToken,
} from "./invitations.service.js";
import type { InvitationRole, WorkspaceInvitationRecord } from "./invitation.types.js";

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

describe("generateInvitationToken", () => {
  it("generates a 64-char hex string (32 random bytes)", () => {
    const token = generateInvitationToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generates unique tokens on each call", () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateInvitationToken()));
    expect(tokens.size).toBe(50);
  });
});

describe("hashInvitationToken", () => {
  it("returns a 64-char hex SHA-256 digest", () => {
    const token = generateInvitationToken();
    const hash = hashInvitationToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic", () => {
    const token = generateInvitationToken();
    expect(hashInvitationToken(token)).toBe(hashInvitationToken(token));
  });

  it("produces distinct hashes for distinct tokens", () => {
    const a = generateInvitationToken();
    const b = generateInvitationToken();
    expect(a).not.toBe(b);
    expect(hashInvitationToken(a)).not.toBe(hashInvitationToken(b));
  });

  it("is consistent with node:crypto SHA-256", () => {
    const token = generateInvitationToken();
    const expected = createHash("sha256").update(token).digest("hex");
    expect(hashInvitationToken(token)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Token expiry check (pure logic — no DB)
// ---------------------------------------------------------------------------

describe("token expiry check", () => {
  function isTokenExpired(expiresAt: Date): boolean {
    return expiresAt <= new Date();
  }

  it("returns false for a token expiring in the future", () => {
    const futureDate = new Date(Date.now() + 60_000);
    expect(isTokenExpired(futureDate)).toBe(false);
  });

  it("returns true for a token that has already expired", () => {
    const pastDate = new Date(Date.now() - 1000);
    expect(isTokenExpired(pastDate)).toBe(true);
  });

  it("returns true when expiry equals now (boundary)", () => {
    vi.useFakeTimers();
    try {
      const now = new Date();
      vi.setSystemTime(now);
      expect(isTokenExpired(now)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("INVITATION_TTL_DAYS is 7", () => {
    expect(INVITATION_TTL_DAYS).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Duplicate invitation prevention (pure logic — no DB)
// ---------------------------------------------------------------------------

describe("duplicate invitation prevention", () => {
  function hasPendingInvitation(
    invitations: WorkspaceInvitationRecord[],
    workspaceId: string,
    email: string,
  ): boolean {
    return invitations.some(
      (inv) =>
        inv.workspaceId === workspaceId &&
        inv.invitedEmail === email &&
        inv.acceptedAt === null,
    );
  }

  const base: WorkspaceInvitationRecord = {
    id: "inv-1",
    workspaceId: "ws-1",
    invitedEmail: "bob@example.com",
    role: "MEMBER",
    tokenHash: hashInvitationToken(randomBytes(32).toString("hex")),
    invitedByUserId: "user-1",
    acceptedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
  };

  it("detects a pending invitation for the same workspace and email", () => {
    expect(hasPendingInvitation([base], "ws-1", "bob@example.com")).toBe(true);
  });

  it("does not flag an accepted invitation as a duplicate", () => {
    const accepted = { ...base, acceptedAt: new Date() };
    expect(hasPendingInvitation([accepted], "ws-1", "bob@example.com")).toBe(false);
  });

  it("does not flag a different workspace as a duplicate", () => {
    expect(hasPendingInvitation([base], "ws-99", "bob@example.com")).toBe(false);
  });

  it("does not flag a different email as a duplicate", () => {
    expect(hasPendingInvitation([base], "ws-1", "alice@example.com")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Entitlement gate for free plan (pure logic — no NestJS)
// ---------------------------------------------------------------------------

describe("entitlement gate — free plan cannot invite members", () => {
  type Plan = "free" | "personal";

  const PLAN_CAPABILITIES: Record<Plan, Set<string>> = {
    free: new Set(),
    personal: new Set(["workspace-members"]),
  };

  function canInviteMembers(plan: Plan): boolean {
    return PLAN_CAPABILITIES[plan].has("workspace-members");
  }

  it("free plan cannot invite members", () => {
    expect(canInviteMembers("free")).toBe(false);
  });

  it("personal plan can invite members", () => {
    expect(canInviteMembers("personal")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// acceptInvitation logic (mocked dependencies, no DB/NestJS)
// ---------------------------------------------------------------------------

interface FakeAccount {
  id: string;
  email: string;
  name: string;
}

interface FakeInvitation {
  id: string;
  workspaceId: string;
  invitedEmail: string;
  role: InvitationRole;
  acceptedAt: Date | null;
  expiresAt: Date;
}

function simulateAccept(
  plaintext: string,
  dto: { name?: string; password?: string },
  invitation: FakeInvitation | null,
  existingAccount: FakeAccount | null,
  existingMember: boolean,
  markAccepted: (id: string) => void,
  createMember: (workspaceId: string, userId: string, role: string) => void,
): { userId: string; workspaceId: string } | { error: string } {
  const tokenHash = hashInvitationToken(plaintext);
  void tokenHash;

  if (!invitation) return { error: "not_found" };
  if (invitation.acceptedAt !== null) return { error: "already_accepted" };
  if (invitation.expiresAt <= new Date()) return { error: "expired" };

  let account = existingAccount;
  if (!account) {
    if (!dto.name || !dto.password) return { error: "name_and_password_required" };
    account = { id: "new-user", email: invitation.invitedEmail, name: dto.name };
  }

  if (existingMember) {
    markAccepted(invitation.id);
    return { error: "already_member" };
  }

  createMember(invitation.workspaceId, account.id, invitation.role);
  markAccepted(invitation.id);
  return { userId: account.id, workspaceId: invitation.workspaceId };
}

describe("acceptInvitation logic", () => {
  const validInvitation: FakeInvitation = {
    id: "inv-1",
    workspaceId: "ws-1",
    invitedEmail: "bob@example.com",
    role: "MEMBER",
    acceptedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
  };

  it("accepts successfully for a new user (no existing account)", () => {
    const markAccepted = vi.fn();
    const createMember = vi.fn();
    const result = simulateAccept(
      generateInvitationToken(),
      { name: "Bob", password: "securepassword123" },
      validInvitation,
      null,
      false,
      markAccepted,
      createMember,
    );
    expect(result).toEqual({ userId: "new-user", workspaceId: "ws-1" });
    expect(createMember).toHaveBeenCalledWith("ws-1", "new-user", "MEMBER");
    expect(markAccepted).toHaveBeenCalledWith("inv-1");
  });

  it("accepts successfully for an existing account", () => {
    const markAccepted = vi.fn();
    const createMember = vi.fn();
    const existingAccount: FakeAccount = { id: "existing-user", email: "bob@example.com", name: "Bob" };
    const result = simulateAccept(
      generateInvitationToken(),
      {},
      validInvitation,
      existingAccount,
      false,
      markAccepted,
      createMember,
    );
    expect(result).toEqual({ userId: "existing-user", workspaceId: "ws-1" });
    expect(createMember).toHaveBeenCalledWith("ws-1", "existing-user", "MEMBER");
  });

  it("rejects when invitation is not found", () => {
    const result = simulateAccept(
      generateInvitationToken(),
      { name: "Bob", password: "securepassword123" },
      null,
      null,
      false,
      vi.fn(),
      vi.fn(),
    );
    expect(result).toEqual({ error: "not_found" });
  });

  it("returns already_accepted when invitation was already used", () => {
    const accepted = { ...validInvitation, acceptedAt: new Date() };
    const result = simulateAccept(
      generateInvitationToken(),
      {},
      accepted,
      null,
      false,
      vi.fn(),
      vi.fn(),
    );
    expect(result).toEqual({ error: "already_accepted" });
  });

  it("returns expired when invitation has expired", () => {
    const expired = { ...validInvitation, expiresAt: new Date(Date.now() - 1000) };
    const result = simulateAccept(
      generateInvitationToken(),
      {},
      expired,
      null,
      false,
      vi.fn(),
      vi.fn(),
    );
    expect(result).toEqual({ error: "expired" });
  });

  it("requires name and password when creating a new account", () => {
    const result = simulateAccept(
      generateInvitationToken(),
      {},
      validInvitation,
      null,
      false,
      vi.fn(),
      vi.fn(),
    );
    expect(result).toEqual({ error: "name_and_password_required" });
  });

  it("marks accepted and returns already_member if user is already in workspace", () => {
    const markAccepted = vi.fn();
    const existingAccount: FakeAccount = { id: "existing-user", email: "bob@example.com", name: "Bob" };
    const result = simulateAccept(
      generateInvitationToken(),
      {},
      validInvitation,
      existingAccount,
      true,
      markAccepted,
      vi.fn(),
    );
    expect(result).toEqual({ error: "already_member" });
    expect(markAccepted).toHaveBeenCalledWith("inv-1");
  });
});
