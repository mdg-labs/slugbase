import type { Port } from "./port.js";

export interface SealedSecret {
  readonly ciphertext: Uint8Array;
  /** The id of the key that sealed it, for rotation. */
  readonly keyId: string;
}

/** Envelope encryption of secrets at rest with a key id for rotation (doc 01 section 6). */
export interface SecretBoxPort extends Port {
  seal(plaintext: Uint8Array): Promise<SealedSecret>;
  open(sealed: SealedSecret): Promise<Uint8Array>;
}
