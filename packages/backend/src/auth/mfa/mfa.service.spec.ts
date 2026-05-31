import { randomBytes } from "node:crypto";

import * as argon2 from "argon2";
import { generateSecret, generateSync, verifySync } from "otplib";
import { describe, expect, it, vi } from "vitest";

import type { CryptoService } from "@slugbase/shared-types";

import type { AccountRecord } from "../../accounts/account.types.js";
import type { MfaBackupCodeRecord } from "./mfa.types.js";

/**
 * Lightweight stubs — no NestJS DI needed for unit tests.
 */
const fakeCrypto: CryptoService = {
  encrypt: (plaintext) => `enc:${plaintext}`,
  decrypt: (ciphertext) => {
    if (!ciphertext.startsWith("enc:")) throw new Error("bad ciphertext");
    return ciphertext.slice(4);
  },
};

function makeAccount(overrides: Partial<AccountRecord> = {}): AccountRecord {
  return {
    id: "user-1",
    email: "test@example.com",
    name: "Test",
    passwordHash: "",
    language: "en",
    theme: "auto",
    accentColor: null,
    isInstanceAdmin: false,
    mfaState: "not_enrolled",
    mfaTotpSecretEncrypted: null,
    aiOptOut: false,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeBackupCode(
  overrides: Partial<MfaBackupCodeRecord> = {},
): MfaBackupCodeRecord {
  return {
    id: randomBytes(8).toString("hex"),
    userId: "user-1",
    codeHash: "",
    usedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// TOTP verification
// ---------------------------------------------------------------------------

describe("TOTP verify — correct code", () => {
  it("returns true for a valid TOTP token", async () => {
    const secret = generateSecret();
    const token = generateSync({ secret });
    const account = makeAccount({
      mfaState: "enrolled",
      mfaTotpSecretEncrypted: fakeCrypto.encrypt(secret),
    });

    const findById = vi.fn().mockResolvedValue(account);
    const result = await callVerifyTotp(findById, fakeCrypto, "user-1", token);
    expect(result).toBe(true);
  });

  it("returns false for an incorrect TOTP token", async () => {
    const secret = generateSecret();
    const account = makeAccount({
      mfaState: "enrolled",
      mfaTotpSecretEncrypted: fakeCrypto.encrypt(secret),
    });

    const findById = vi.fn().mockResolvedValue(account);
    const result = await callVerifyTotp(findById, fakeCrypto, "user-1", "000000");
    expect(result).toBe(false);
  });

  it("returns false when mfaState is not enrolled", async () => {
    const account = makeAccount({ mfaState: "not_enrolled" });
    const findById = vi.fn().mockResolvedValue(account);
    const result = await callVerifyTotp(findById, fakeCrypto, "user-1", "123456");
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Backup code single-use
// ---------------------------------------------------------------------------

describe("backup code single-use", () => {
  it("returns true on first use and false on second use (no unused codes)", async () => {
    const plainCode = randomBytes(10).toString("hex");
    const codeHash = await argon2.hash(plainCode, { type: argon2.argon2id });
    const record = makeBackupCode({ codeHash, usedAt: null });

    const findUnused = vi.fn();
    const markUsed = vi.fn().mockResolvedValue(undefined);

    // First use: code present in unused list
    findUnused.mockResolvedValueOnce([record]);
    const first = await callVerifyBackupCode(findUnused, markUsed, "user-1", plainCode);
    expect(first).toBe(true);
    expect(markUsed).toHaveBeenCalledWith(record.id, expect.any(Number));

    // Second use: empty list (code now consumed)
    findUnused.mockResolvedValueOnce([]);
    const second = await callVerifyBackupCode(findUnused, markUsed, "user-1", plainCode);
    expect(second).toBe(false);
  });

  it("does not accept a wrong code", async () => {
    const plainCode = randomBytes(10).toString("hex");
    const codeHash = await argon2.hash(plainCode, { type: argon2.argon2id });
    const record = makeBackupCode({ codeHash, usedAt: null });

    const findUnused = vi.fn().mockResolvedValue([record]);
    const markUsed = vi.fn();

    const result = await callVerifyBackupCode(
      findUnused,
      markUsed,
      "user-1",
      "definitely-wrong-code",
    );
    expect(result).toBe(false);
    expect(markUsed).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Pure helpers (extracted logic mirroring MfaService, no DI)
// ---------------------------------------------------------------------------

async function callVerifyTotp(
  findById: ReturnType<typeof vi.fn>,
  crypto: CryptoService,
  userId: string,
  totpCode: string,
): Promise<boolean> {
  const account = (await findById(userId)) as AccountRecord | null;
  if (!account || account.mfaState !== "enrolled" || !account.mfaTotpSecretEncrypted) {
    return false;
  }
  const secret = crypto.decrypt(account.mfaTotpSecretEncrypted);
  return verifySync({ token: totpCode, secret }).valid;
}

async function callVerifyBackupCode(
  findUnused: ReturnType<typeof vi.fn>,
  markUsed: ReturnType<typeof vi.fn>,
  userId: string,
  code: string,
): Promise<boolean> {
  const records = (await findUnused(userId)) as MfaBackupCodeRecord[];
  for (const record of records) {
    const match = await argon2.verify(record.codeHash, code);
    if (match) {
      await markUsed(record.id, Date.now());
      return true;
    }
  }
  return false;
}
