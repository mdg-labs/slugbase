import { describe, expect, it } from "vitest";

import {
  MIN_ADMIN_PASSWORD_LENGTH,
  AdminPasswordService,
} from "./password.service.js";

describe("AdminPasswordService", () => {
  const passwords = new AdminPasswordService();

  it("rejects passwords shorter than 12 characters", () => {
    expect(() => {
      passwords.assertPasswordPolicy("short");
    }).toThrow(
      `Password must be at least ${String(MIN_ADMIN_PASSWORD_LENGTH)} characters`,
    );
  });

  it("hashes and verifies with argon2id", async () => {
    const plaintext = "valid-password-12";
    const hash = await passwords.hashPassword(plaintext);
    expect(hash).toContain("$argon2id$");
    await expect(passwords.verifyPassword(hash, plaintext)).resolves.toBe(true);
    await expect(passwords.verifyPassword(hash, "wrong-password")).resolves.toBe(
      false,
    );
  });
});
