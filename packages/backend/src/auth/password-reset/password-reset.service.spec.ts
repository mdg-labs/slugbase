import { randomBytes } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { generateResetToken, hashResetToken, buildPasswordResetUrl } from "./password-reset.service.js";

// ---------------------------------------------------------------------------
// Pure helper tests - no NestJS DI needed
// ---------------------------------------------------------------------------

describe("hashResetToken", () => {
  it("returns a 64-char hex string (SHA-256 digest)", () => {
    const token = generateResetToken();
    const hash = hashResetToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic - same input yields same hash", () => {
    const token = generateResetToken();
    expect(hashResetToken(token)).toBe(hashResetToken(token));
  });

  it("produces distinct hashes for distinct tokens", () => {
    const a = generateResetToken();
    const b = generateResetToken();
    expect(a).not.toBe(b);
    expect(hashResetToken(a)).not.toBe(hashResetToken(b));
  });
});

describe("generateResetToken", () => {
  it("generates a 64-char hex string (32 random bytes)", () => {
    const token = generateResetToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generates unique tokens on each call", () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateResetToken()));
    expect(tokens.size).toBe(50);
  });
});

describe("buildPasswordResetUrl", () => {
  const token = "abc123def456";

  it("uses FRONTEND_ORIGIN and /reset-password when web is not served by the API", () => {
    const url = buildPasswordResetUrl({
      appBaseUrl: "https://api.slugbase.test",
      frontendOrigin: "https://app.slugbase.test",
      serveWebClient: false,
      token,
    });

    expect(url).toBe(`https://app.slugbase.test/reset-password?token=${token}`);
  });

  it("uses APP_BASE_URL when SERVE_WEB_CLIENT is enabled (combined self-host)", () => {
    const url = buildPasswordResetUrl({
      appBaseUrl: "https://slugbase.example.com",
      frontendOrigin: "https://app.slugbase.test",
      serveWebClient: true,
      token,
    });

    expect(url).toBe(`https://slugbase.example.com/reset-password?token=${token}`);
  });

  it("normalizes trailing slashes on the configured origin", () => {
    const url = buildPasswordResetUrl({
      appBaseUrl: "https://api.slugbase.test/",
      frontendOrigin: "https://app.slugbase.test/",
      serveWebClient: false,
      token,
    });

    expect(url).toBe(`https://app.slugbase.test/reset-password?token=${token}`);
  });
});

// ---------------------------------------------------------------------------
// Token expiry check (pure logic - no DB)
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

  it("returns true for a token expiring exactly now", () => {
    vi.useFakeTimers();
    try {
      const now = new Date();
      vi.setSystemTime(now);
      expect(isTokenExpired(now)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Hash round-trip
// ---------------------------------------------------------------------------

describe("hash round-trip", () => {
  it("verifies correctly: hashResetToken(plain) === hashResetToken(plain)", () => {
    const plain = randomBytes(32).toString("hex");
    const hash = hashResetToken(plain);
    expect(hashResetToken(plain)).toBe(hash);
  });

  it("rejects a tampered token", () => {
    const plain = randomBytes(32).toString("hex");
    const other = randomBytes(32).toString("hex");
    expect(hashResetToken(plain)).not.toBe(hashResetToken(other));
  });
});

// ---------------------------------------------------------------------------
// Non-enumerating response logic (pure logic - no DB)
// ---------------------------------------------------------------------------

describe("non-enumerating forgotPassword logic", () => {
  /**
   * Simulates the forgotPassword logic: always resolves, regardless of
   * whether the email is registered. Callers must return the same 200.
   */
  async function callForgotPassword(
    email: string,
    findByEmail: (e: string) => Promise<{ id: string } | null>,
    issueToken: (userId: string) => Promise<void>,
  ): Promise<{ issued: boolean }> {
    const account = await findByEmail(email);
    if (!account) return { issued: false };
    await issueToken(account.id);
    return { issued: true };
  }

  it("resolves without error for an unknown email", async () => {
    const issueToken = vi.fn();
    const result = await callForgotPassword(
      "unknown@example.com",
      () => Promise.resolve(null),
      issueToken,
    );
    expect(result).toEqual({ issued: false });
    expect(issueToken).not.toHaveBeenCalled();
  });

  it("issues a token for a known email", async () => {
    const issueToken = vi.fn().mockResolvedValue(undefined);
    const result = await callForgotPassword(
      "user@example.com",
      () => Promise.resolve({ id: "user-1" }),
      issueToken,
    );
    expect(result).toEqual({ issued: true });
    expect(issueToken).toHaveBeenCalledWith("user-1");
  });
});

// ---------------------------------------------------------------------------
// resetPassword logic (pure - no DB)
// ---------------------------------------------------------------------------

interface TokenRecord {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
}

function makeTokenRecord(overrides: Partial<TokenRecord> = {}): TokenRecord {
  return {
    id: "tok-1",
    userId: "user-1",
    tokenHash: hashResetToken("abc"),
    expiresAt: new Date(Date.now() + 60_000),
    usedAt: null,
    ...overrides,
  };
}

describe("resetPassword logic", () => {
  async function callResetPassword(
    plaintext: string,
    findByHash: (hash: string) => Promise<TokenRecord | null>,
    markUsed: (id: string, nowMs: number) => Promise<void>,
    updatePassword: (userId: string, newPassword: string) => Promise<void>,
    revokeSessions: (userId: string) => Promise<void>,
  ): Promise<{ ok: boolean } | { error: string }> {
    const tokenHash = hashResetToken(plaintext);
    const record = await findByHash(tokenHash);

    if (!record) return { error: "invalid" };
    if (record.usedAt !== null) return { error: "already used" };
    if (record.expiresAt <= new Date()) return { error: "expired" };

    await markUsed(record.id, Date.now());
    await updatePassword(record.userId, "new-password-value");
    await revokeSessions(record.userId);
    return { ok: true };
  }

  it("succeeds with a valid unused token and revokes sessions", async () => {
    const plaintext = generateResetToken();
    const record = makeTokenRecord({ tokenHash: hashResetToken(plaintext) });

    const markUsed = vi.fn().mockResolvedValue(undefined);
    const updatePassword = vi.fn().mockResolvedValue(undefined);
    const revokeSessions = vi.fn().mockResolvedValue(undefined);

    const result = await callResetPassword(
      plaintext,
      () => Promise.resolve(record),
      markUsed,
      updatePassword,
      revokeSessions,
    );

    expect(result).toEqual({ ok: true });
    expect(markUsed).toHaveBeenCalledWith("tok-1", expect.any(Number));
    expect(updatePassword).toHaveBeenCalledWith("user-1", "new-password-value");
    expect(revokeSessions).toHaveBeenCalledWith("user-1");
  });

  it("rejects when token hash is not found", async () => {
    const result = await callResetPassword(
      generateResetToken(),
      () => Promise.resolve(null),
      vi.fn(),
      vi.fn(),
      vi.fn(),
    );
    expect(result).toEqual({ error: "invalid" });
  });

  it("rejects a token that has already been used", async () => {
    const plaintext = generateResetToken();
    const record = makeTokenRecord({
      tokenHash: hashResetToken(plaintext),
      usedAt: new Date(Date.now() - 1000),
    });

    const result = await callResetPassword(
      plaintext,
      () => Promise.resolve(record),
      vi.fn(),
      vi.fn(),
      vi.fn(),
    );
    expect(result).toEqual({ error: "already used" });
  });

  it("rejects an expired token", async () => {
    const plaintext = generateResetToken();
    const record = makeTokenRecord({
      tokenHash: hashResetToken(plaintext),
      expiresAt: new Date(Date.now() - 1000),
    });

    const result = await callResetPassword(
      plaintext,
      () => Promise.resolve(record),
      vi.fn(),
      vi.fn(),
      vi.fn(),
    );
    expect(result).toEqual({ error: "expired" });
  });

  it("does not revoke sessions when token is invalid", async () => {
    const revokeSessions = vi.fn();

    await callResetPassword(
      generateResetToken(),
      () => Promise.resolve(null),
      vi.fn(),
      vi.fn(),
      revokeSessions,
    );

    expect(revokeSessions).not.toHaveBeenCalled();
  });
});
