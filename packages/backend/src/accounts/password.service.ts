import * as argon2 from "argon2";

const MIN_PASSWORD_LENGTH = 12;

export interface PasswordPolicyResult {
  valid: boolean;
  reason?: string;
  /** Simple strength score 0–4. */
  strength: 0 | 1 | 2 | 3 | 4;
}

/**
 * Computes a simple strength score (0–4) based on length and character-class variety.
 * This is a lightweight server-side signal; the client may use a dedicated library for
 * richer feedback.
 */
function computeStrength(password: string): 0 | 1 | 2 | 3 | 4 {
  let score = 0;
  if (password.length >= 12) score++;
  if (password.length >= 16) score++;
  if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score++;
  if (/[0-9]/.test(password)) score++;
  if (/[^A-Za-z0-9]/.test(password)) score++;
  return Math.min(score, 4) as 0 | 1 | 2 | 3 | 4;
}

export class PasswordService {
  checkPasswordPolicy(password: string): PasswordPolicyResult {
    const strength = computeStrength(password);

    if (password.length < MIN_PASSWORD_LENGTH) {
      return {
        valid: false,
        reason: `Password must be at least ${String(MIN_PASSWORD_LENGTH)} characters`,
        strength,
      };
    }

    return { valid: true, strength };
  }

  async hashPassword(plaintext: string): Promise<string> {
    return argon2.hash(plaintext, { type: argon2.argon2id });
  }

  async verifyPassword(hash: string, plaintext: string): Promise<boolean> {
    return argon2.verify(hash, plaintext);
  }
}
