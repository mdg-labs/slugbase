import type { Port } from "./port.ts";

export interface SealedSecret {
  readonly ciphertext: Uint8Array;
  /** The id of the key that sealed it, for rotation. */
  readonly keyId: string;
}

export interface SecretBoxOptions {
  /**
   * Additional authenticated data that binds a sealed value to where it is
   * stored (its table, column and row). A value opens only with the data it
   * was sealed with, so a ciphertext copied to another column or row fails.
   * It is not secret and must not be empty.
   */
  readonly aad: Uint8Array;
}

/** Envelope encryption of secrets at rest with a key id for rotation (doc 01 section 6). */
export interface SecretBoxPort extends Port {
  seal(plaintext: Uint8Array, options: SecretBoxOptions): Promise<SealedSecret>;
  open(sealed: SealedSecret, options: SecretBoxOptions): Promise<Uint8Array>;
  /** True for any key id other than the current key's: the value should be resealed. */
  needsRotation(keyId: string): Promise<boolean>;
  /** Opens `sealed` with the key that sealed it and seals it again under the current key. */
  reseal(sealed: SealedSecret, options: SecretBoxOptions): Promise<SealedSecret>;
}
