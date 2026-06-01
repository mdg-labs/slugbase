import { randomBytes } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  generateVerificationToken,
  hashToken,
  maskEmailForDisplay,
  buildEmailVerificationUrl,
} from "./email-verification.service.js";

// ---------------------------------------------------------------------------
// Pure helper tests — no NestJS DI needed
// ---------------------------------------------------------------------------

describe("hashToken", () => {
  it("returns a 64-char hex string (SHA-256 digest)", () => {
    const token = generateVerificationToken();
    const hash = hashToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic — same input yields same hash", () => {
    const token = generateVerificationToken();
    expect(hashToken(token)).toBe(hashToken(token));
  });

  it("produces distinct hashes for distinct tokens", () => {
    const a = generateVerificationToken();
    const b = generateVerificationToken();
    expect(a).not.toBe(b);
    expect(hashToken(a)).not.toBe(hashToken(b));
  });
});

describe("maskEmailForDisplay", () => {
  it("masks the local part and domain for a typical address", () => {
    expect(maskEmailForDisplay("typo@example.com")).toBe("t***@e***.com");
  });

  it("returns a safe fallback for malformed input", () => {
    expect(maskEmailForDisplay("invalid")).toBe("***@***.***");
  });
});

describe("buildEmailVerificationUrl", () => {
  const token = "abc123def456";

  it("uses FRONTEND_ORIGIN and /verify-email when web is not served by the API", () => {
    const url = buildEmailVerificationUrl({
      appBaseUrl: "https://api.slugbase.test",
      frontendOrigin: "https://app.slugbase.test",
      serveWebClient: false,
      token,
    });

    expect(url).toBe(`https://app.slugbase.test/verify-email?token=${token}`);
  });

  it("uses APP_BASE_URL when SERVE_WEB_CLIENT is enabled (combined self-host)", () => {
    const url = buildEmailVerificationUrl({
      appBaseUrl: "https://slugbase.example.com",
      frontendOrigin: "https://app.slugbase.test",
      serveWebClient: true,
      token,
    });

    expect(url).toBe(`https://slugbase.example.com/verify-email?token=${token}`);
  });

  it("normalizes trailing slashes on the configured origin", () => {
    const url = buildEmailVerificationUrl({
      appBaseUrl: "https://api.slugbase.test/",
      frontendOrigin: "https://app.slugbase.test/",
      serveWebClient: false,
      token,
    });

    expect(url).toBe(`https://app.slugbase.test/verify-email?token=${token}`);
  });
});

describe("generateVerificationToken", () => {
  it("generates a 64-char hex string (32 random bytes)", () => {
    const token = generateVerificationToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generates unique tokens on each call", () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateVerificationToken()));
    expect(tokens.size).toBe(50);
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

  it("returns true for a token expiring exactly now", () => {
    vi.useFakeTimers();
    try {
      const now = new Date();
      vi.setSystemTime(now);
      // A date that equals `new Date()` inside the check — expired (<=)
      expect(isTokenExpired(now)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Rate-limit counter check (pure logic — no DB)
// ---------------------------------------------------------------------------

describe("rate-limit counter", () => {
  const MAX_RESENDS_PER_HOUR = 3;

  function isRateLimited(recentCount: number): boolean {
    return recentCount >= MAX_RESENDS_PER_HOUR;
  }

  it("allows when count is below the limit", () => {
    expect(isRateLimited(0)).toBe(false);
    expect(isRateLimited(1)).toBe(false);
    expect(isRateLimited(2)).toBe(false);
  });

  it("blocks when count equals the limit", () => {
    expect(isRateLimited(3)).toBe(true);
  });

  it("blocks when count exceeds the limit", () => {
    expect(isRateLimited(4)).toBe(true);
    expect(isRateLimited(100)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Hash verification round-trip
// ---------------------------------------------------------------------------

describe("hash verification round-trip", () => {
  it("verifies correctly: hash(plain) === hash(plain)", () => {
    const plain = randomBytes(32).toString("hex");
    const hash = hashToken(plain);
    expect(hashToken(plain)).toBe(hash);
  });

  it("rejects a tampered token: hash(plain) !== hash(other)", () => {
    const plain = randomBytes(32).toString("hex");
    const other = randomBytes(32).toString("hex");
    expect(hashToken(plain)).not.toBe(hashToken(other));
  });
});

// ---------------------------------------------------------------------------
// Integration-style logic tests (mocked dependencies, no DB/NestJS)
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
    tokenHash: hashToken("abc"),
    expiresAt: new Date(Date.now() + 60_000),
    usedAt: null,
    ...overrides,
  };
}

describe("verifyToken logic", () => {
  async function callVerifyToken(
    plaintext: string,
    findByHash: (hash: string) => Promise<TokenRecord | null>,
    markUsed: (id: string, nowMs: number) => Promise<void>,
    markEmailVerified: (userId: string) => Promise<void>,
  ): Promise<{ userId: string } | { error: string }> {
    const tokenHash = hashToken(plaintext);
    const record = await findByHash(tokenHash);

    if (!record) return { error: "invalid" };
    if (record.usedAt !== null) return { error: "already used" };
    if (record.expiresAt <= new Date()) return { error: "expired" };

    await markUsed(record.id, Date.now());
    await markEmailVerified(record.userId);
    return { userId: record.userId };
  }

  it("succeeds with a valid unused token", async () => {
    const plaintext = generateVerificationToken();
    const record = makeTokenRecord({ tokenHash: hashToken(plaintext) });

    const markUsed = vi.fn().mockResolvedValue(undefined);
    const markEmailVerified = vi.fn().mockResolvedValue(undefined);

    const result = await callVerifyToken(
      plaintext,
      () => Promise.resolve(record),
      markUsed,
      markEmailVerified,
    );
    expect(result).toEqual({ userId: "user-1" });
    expect(markUsed).toHaveBeenCalledWith("tok-1", expect.any(Number));
    expect(markEmailVerified).toHaveBeenCalledWith("user-1");
  });

  it("rejects when token hash is not found", async () => {
    const result = await callVerifyToken(
      generateVerificationToken(),
      () => Promise.resolve(null),
      vi.fn(),
      vi.fn(),
    );
    expect(result).toEqual({ error: "invalid" });
  });

  it("rejects a token that has already been used", async () => {
    const plaintext = generateVerificationToken();
    const record = makeTokenRecord({
      tokenHash: hashToken(plaintext),
      usedAt: new Date(Date.now() - 1000),
    });

    const result = await callVerifyToken(
      plaintext,
      () => Promise.resolve(record),
      vi.fn(),
      vi.fn(),
    );
    expect(result).toEqual({ error: "already used" });
  });

  it("rejects an expired token", async () => {
    const plaintext = generateVerificationToken();
    const record = makeTokenRecord({
      tokenHash: hashToken(plaintext),
      expiresAt: new Date(Date.now() - 1000),
    });

    const result = await callVerifyToken(
      plaintext,
      () => Promise.resolve(record),
      vi.fn(),
      vi.fn(),
    );
    expect(result).toEqual({ error: "expired" });
  });
});

describe("correctSignupEmail logic", () => {
  interface Account {
    id: string;
    email: string;
    emailVerified: boolean;
  }

  async function callCorrectSignupEmail(
    userId: string,
    newEmail: string,
    findById: (id: string) => Promise<Account | null>,
    findByEmail: (email: string) => Promise<Account | null>,
  ): Promise<{ maskedEmail: string } | { error: string; status: number }> {
    const account = await findById(userId);
    if (!account) return { error: "not found", status: 404 };

    if (account.emailVerified) {
      return { error: "already verified", status: 403 };
    }

    const normalizedEmail = newEmail.trim();
    if (normalizedEmail.toLowerCase() === account.email.toLowerCase()) {
      return { maskedEmail: maskEmailForDisplay(account.email) };
    }

    const existing = await findByEmail(normalizedEmail);
    if (existing && existing.id !== userId) {
      return { error: "conflict", status: 409 };
    }

    return { maskedEmail: maskEmailForDisplay(normalizedEmail) };
  }

  it("rejects when the account is already verified", async () => {
    const result = await callCorrectSignupEmail(
      "user-1",
      "new@example.com",
      () =>
        Promise.resolve({
          id: "user-1",
          email: "old@example.com",
          emailVerified: true,
        }),
      () => Promise.resolve(null),
    );
    expect(result).toEqual({ error: "already verified", status: 403 });
  });

  it("returns masked email without changes when the address is unchanged", async () => {
    const result = await callCorrectSignupEmail(
      "user-1",
      "  Typo@Example.com ",
      () =>
        Promise.resolve({
          id: "user-1",
          email: "typo@example.com",
          emailVerified: false,
        }),
      () => Promise.resolve(null),
    );
    expect(result).toEqual({ maskedEmail: "t***@e***.com" });
  });

  it("rejects when the new email belongs to another account", async () => {
    const result = await callCorrectSignupEmail(
      "user-1",
      "taken@example.com",
      () =>
        Promise.resolve({
          id: "user-1",
          email: "typo@example.com",
          emailVerified: false,
        }),
      () =>
        Promise.resolve({
          id: "user-2",
          email: "taken@example.com",
          emailVerified: true,
        }),
    );
    expect(result).toEqual({ error: "conflict", status: 409 });
  });
});
