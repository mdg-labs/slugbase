// First-run setup (doc 02 section 2.2, doc 04 section 10.2): the rules the
// setup request is held to before anything is written. The functions here are
// pure; the single-shot creation of the first account is the system operation
// `sys_complete_setup` of `@slugbase/db`.

/** The shortest password an account may have (doc 02 section 2.5). */
export const PASSWORD_MIN_LENGTH = 12;

/** The longest password an account may have; the cap keeps the cost of hashing bounded. */
export const PASSWORD_MAX_LENGTH = 256;

/** Why a password fails the length rule; the codes of `errors[]` on `weak_password` (doc 04 section 3.2). */
export type PasswordLengthProblem = "too_short" | "too_long";

/**
 * Whether a password is within {@link PASSWORD_MIN_LENGTH} and {@link PASSWORD_MAX_LENGTH}
 * characters, counted in code points so a character outside the Basic Multilingual Plane is one.
 * There are no composition rules and the password is not normalised or trimmed.
 */
export function passwordLengthProblem(password: string): PasswordLengthProblem | undefined {
  // A string longer than twice the cap has more code points than the cap.
  if (password.length > PASSWORD_MAX_LENGTH * 2) {
    return "too_long";
  }
  const length = Array.from(password).length;
  if (length < PASSWORD_MIN_LENGTH) {
    return "too_short";
  }
  return length > PASSWORD_MAX_LENGTH ? "too_long" : undefined;
}
