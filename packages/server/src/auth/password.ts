import { randomBytes } from "node:crypto";
import { hash, parseOptions, verify } from "@node-rs/argon2";

// Passwords are argon2id PHC strings (doc 01 section 10, doc 05 section 2.1).
// The parameters are those of the argon2 library's defaults, which follow the
// OWASP minimum for argon2id (19 MiB of memory, two passes, one lane). The
// library hashes and verifies off the event loop.

const ARGON2ID_PREFIX = "$argon2id$";

/** Hashes a password into a PHC string with a random salt. */
export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

/** Whether `code` matches the argon2id PHC string `stored`; a string the library cannot read is an error, never a match. */
export function verifyHash(stored: string, code: string): Promise<boolean> {
  return verify(stored, code);
}

/** Whether `stored` is an argon2id PHC string the library can read; anything else is treated as no password. */
function isArgon2id(stored: string): boolean {
  if (!stored.startsWith(ARGON2ID_PREFIX)) {
    return false;
  }
  try {
    parseOptions(stored);
    return true;
  } catch {
    return false;
  }
}

export interface PasswordVerifier {
  /**
   * Whether `password` matches `stored`. It always costs one argon2id
   * verification: when the account has no usable hash (`stored` is absent, or
   * not an argon2id string) it verifies against a dummy hash and answers false,
   * so an unknown email, an account without a password and a wrong password
   * take the same time (doc 02 section 2.3, doc 10 T8).
   */
  verify(stored: string | null | undefined, password: string): Promise<boolean>;
}

/** A verifier whose dummy hash is made on the first use, with the parameters `hashPassword` uses. */
export function createPasswordVerifier(): PasswordVerifier {
  let dummy: Promise<string> | undefined;
  const dummyHash = (): Promise<string> => {
    dummy ??= hashPassword(randomBytes(24).toString("base64url")).catch((error: unknown) => {
      dummy = undefined;
      throw error;
    });
    return dummy;
  };

  return {
    async verify(stored, password) {
      if (stored === null || stored === undefined || !isArgon2id(stored)) {
        await verify(await dummyHash(), password);
        return false;
      }
      return verify(stored, password);
    },
  };
}
