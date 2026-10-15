import { describe, expect, it } from "vitest";
import { passwordScore } from "../src/auth/password-strength.ts";

describe("passwordScore", () => {
  it("scores nothing as the weakest", () => {
    expect(passwordScore("")).toBe(0);
  });

  it.each(["password1234", "Password123!", "qwertyuiop12", "aaaaaaaaaaaa", "abcdefghijkl", "123456789012", "Welcome2024!"])(
    "scores the guessable %s as weak at most",
    (password) => {
      expect(passwordScore(password)).toBeLessThanOrEqual(1);
    },
  );

  it("never scores a password under the minimum length above weak, however mixed", () => {
    expect(passwordScore("Xk9#mQ2$vL7")).toBeLessThanOrEqual(1);
  });

  it("scores a long random-looking password as strong", () => {
    expect(passwordScore("Xk9#mQ2$vL7pR4!wZ")).toBe(4);
  });

  it("scores a long passphrase as strong", () => {
    expect(passwordScore("correct horse battery staple")).toBe(4);
  });

  it("rises with length for the same characters", () => {
    expect(passwordScore("tqzvkjhwmbxn")).toBeLessThan(passwordScore("tqzvkjhwmbxnrpdfglsc"));
  });

  it("scores a mixed password higher than its lowercase twin", () => {
    expect(passwordScore("tqzvkjhwmbxn")).toBeLessThan(passwordScore("tQzVkJh7mBx#"));
  });
});
