import { describe, expect, it } from "vitest";

import { PasswordService } from "./password.service.js";

describe("PasswordService", () => {
  const svc = new PasswordService();

  describe("checkPasswordPolicy", () => {
    it("rejects passwords shorter than 12 characters", () => {
      const result = svc.checkPasswordPolicy("short");
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/12/);
    });

    it("rejects password exactly 11 characters", () => {
      const result = svc.checkPasswordPolicy("onlyaletter");
      expect(result.valid).toBe(false);
    });

    it("accepts password of exactly 12 characters", () => {
      const result = svc.checkPasswordPolicy("validpassword");
      expect(result.valid).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it("accepts a long complex password", () => {
      const result = svc.checkPasswordPolicy("V3ryS3cure!Password");
      expect(result.valid).toBe(true);
    });

    it("returns a strength score between 0 and 4", () => {
      const { strength } = svc.checkPasswordPolicy("validpassword");
      expect(strength).toBeGreaterThanOrEqual(0);
      expect(strength).toBeLessThanOrEqual(4);
    });

    it("assigns higher strength to complex passwords", () => {
      const simple = svc.checkPasswordPolicy("validpassword12");
      const complex = svc.checkPasswordPolicy("V4lid!P4ssword#Abc");
      expect(complex.strength).toBeGreaterThan(simple.strength);
    });
  });

  describe("hashPassword / verifyPassword", () => {
    it("produces a hash that verifies successfully", async () => {
      const plain = "my-secret-password-123";
      const hash = await svc.hashPassword(plain);
      expect(hash).not.toBe(plain);
      expect(hash.startsWith("$argon2id$")).toBe(true);

      const ok = await svc.verifyPassword(hash, plain);
      expect(ok).toBe(true);
    });

    it("rejects an incorrect plaintext", async () => {
      const hash = await svc.hashPassword("correct-password-abc");
      const ok = await svc.verifyPassword(hash, "wrong-password-xyz");
      expect(ok).toBe(false);
    });

    it("produces a different hash each call (salted)", async () => {
      const plain = "same-password-abc123";
      const h1 = await svc.hashPassword(plain);
      const h2 = await svc.hashPassword(plain);
      expect(h1).not.toBe(h2);
    });
  });
});
