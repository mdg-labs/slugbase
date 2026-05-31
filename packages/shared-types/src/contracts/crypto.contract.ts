/**
 * At-rest secret encryption contract (spec §11.11).
 * Implementations use ENCRYPTION_KEY from deployment configuration.
 */
export interface CryptoService {
  /** Encrypts a UTF-8 string; returns an opaque ciphertext string safe for DB storage. */
  encrypt(plaintext: string): string;

  /**
   * Decrypts a value produced by {@link encrypt}.
   * In strict mode (production), any failure throws {@link CryptoDecryptError}
   * instead of returning empty or pass-through plaintext.
   */
  decrypt(ciphertext: string): string;
}

export class CryptoDecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CryptoDecryptError";
  }
}

export class CryptoEncryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CryptoEncryptError";
  }
}
