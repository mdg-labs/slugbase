import { describe, expect, it } from "vitest";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, passwordLengthProblem } from "../../src/auth/setup.ts";

describe("passwordLengthProblem", () => {
  it("accepts a password of 12 to 256 characters", () => {
    expect(PASSWORD_MIN_LENGTH).toBe(12);
    expect(PASSWORD_MAX_LENGTH).toBe(256);
    expect(passwordLengthProblem("a".repeat(12))).toBeUndefined();
    expect(passwordLengthProblem("a".repeat(256))).toBeUndefined();
  });

  it("refuses 11 characters as too short and 257 as too long", () => {
    expect(passwordLengthProblem("a".repeat(11))).toBe("too_short");
    expect(passwordLengthProblem("")).toBe("too_short");
    expect(passwordLengthProblem("a".repeat(257))).toBe("too_long");
    expect(passwordLengthProblem("a".repeat(100_000))).toBe("too_long");
  });

  it("counts a character outside the Basic Multilingual Plane once", () => {
    expect(passwordLengthProblem("\u{1F511}".repeat(12))).toBeUndefined();
    expect(passwordLengthProblem("\u{1F511}".repeat(11))).toBe("too_short");
    expect(passwordLengthProblem("\u{1F511}".repeat(256))).toBeUndefined();
    expect(passwordLengthProblem("\u{1F511}".repeat(257))).toBe("too_long");
  });

  it("applies no composition rule and does not trim", () => {
    expect(passwordLengthProblem("            ")).toBeUndefined();
    expect(passwordLengthProblem("aaaaaaaaaaaa")).toBeUndefined();
  });
});
