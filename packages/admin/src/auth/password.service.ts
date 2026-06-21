import * as argon2 from "argon2";

export const MIN_ADMIN_PASSWORD_LENGTH = 12;

export class AdminPasswordService {
  assertPasswordPolicy(password: string): void {
    if (password.length < MIN_ADMIN_PASSWORD_LENGTH) {
      throw new Error(
        `Password must be at least ${String(MIN_ADMIN_PASSWORD_LENGTH)} characters`,
      );
    }
  }

  async hashPassword(plaintext: string): Promise<string> {
    this.assertPasswordPolicy(plaintext);
    return argon2.hash(plaintext, { type: argon2.argon2id });
  }

  async verifyPassword(hash: string, plaintext: string): Promise<boolean> {
    return argon2.verify(hash, plaintext);
  }
}
