import type { BreachedPasswords } from "./breached/index.ts";

// The password policy (doc 02 section 2.5, Q15): the single entry point every flow that sets a
// password calls before it hashes one. The functions here are pure; the rules are a length of 12 to
// 256 characters, no composition rules, and a password that is not in the breached-password dataset.

/** The shortest password an account may have (doc 02 section 2.5). */
export const PASSWORD_MIN_LENGTH = 12;

/** The longest password an account may have; the cap keeps the cost of hashing bounded. */
export const PASSWORD_MAX_LENGTH = 256;

/** Why a password is refused; the codes of `errors[]` on `weak_password` (doc 04 section 3.2). */
export type PasswordProblem = "too_short" | "too_long" | "breached";

export interface PasswordPolicy {
  /**
   * The reasons the password is refused, empty when it is acceptable. Length is judged first, in code
   * points so a character outside the Basic Multilingual Plane is one; a password outside the length
   * range is not looked up. There are no composition rules and the password is not normalised or trimmed.
   */
  check(password: string): readonly PasswordProblem[];
}

export interface PasswordPolicyOptions {
  /** The breached-password dataset; left out, only the length rules apply (an operator turned the check off). */
  readonly breached?: BreachedPasswords | undefined;
}

export function createPasswordPolicy({ breached }: PasswordPolicyOptions = {}): PasswordPolicy {
  return {
    check(password) {
      // A string longer than twice the cap has more code points than the cap.
      if (password.length > PASSWORD_MAX_LENGTH * 2) {
        return ["too_long"];
      }
      const length = Array.from(password).length;
      if (length < PASSWORD_MIN_LENGTH) {
        return ["too_short"];
      }
      if (length > PASSWORD_MAX_LENGTH) {
        return ["too_long"];
      }
      return breached?.has(password) === true ? ["breached"] : [];
    },
  };
}
