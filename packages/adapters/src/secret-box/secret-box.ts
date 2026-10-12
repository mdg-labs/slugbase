import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { SealedSecret, SecretBoxOptions, SecretBoxPort } from "@slugbase/core";
import { SecretBoxError } from "./errors.ts";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface SecretBoxKey {
  readonly keyId: string;
  /** The 32 raw bytes of the key. */
  readonly key: Uint8Array;
}

export interface CreateSecretBoxOptions {
  /** Seals new values and reseals old ones. */
  readonly current: SecretBoxKey;
  /** Retired keys, used only to open values sealed before a rotation. */
  readonly previous?: readonly SecretBoxKey[];
}

function checkedKeys(options: CreateSecretBoxOptions): Map<string, Buffer> {
  const keys = new Map<string, Buffer>();
  for (const { keyId, key } of [options.current, ...(options.previous ?? [])]) {
    if (keyId === "" || keys.has(keyId) || key.length !== KEY_BYTES) {
      throw new SecretBoxError("configure");
    }
    keys.set(keyId, Buffer.from(key));
  }
  return keys;
}

/**
 * AES-256-GCM envelope encryption (doc 01 section 6). A sealed value is
 * `iv (12 bytes) || encrypted bytes || tag (16 bytes)` under a fresh random IV;
 * the id of the key that sealed it travels next to it, so a rotation can find
 * the values still under an old key. The additional authenticated data binds a
 * value to its column and row.
 */
export function createSecretBox(options: CreateSecretBoxOptions): SecretBoxPort {
  const keys = checkedKeys(options);
  const currentKeyId = options.current.keyId;

  function seal(plaintext: Uint8Array, { aad }: SecretBoxOptions): SealedSecret {
    const key = keys.get(currentKeyId);
    if (key === undefined || aad.length === 0) {
      throw new SecretBoxError("seal");
    }
    try {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
      cipher.setAAD(aad);
      const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return { ciphertext: new Uint8Array(Buffer.concat([iv, encrypted, cipher.getAuthTag()])), keyId: currentKeyId };
    } catch {
      throw new SecretBoxError("seal");
    }
  }

  function open(sealed: SealedSecret, { aad }: SecretBoxOptions): Uint8Array {
    const key = keys.get(sealed.keyId);
    if (key === undefined || aad.length === 0 || sealed.ciphertext.length < IV_BYTES + TAG_BYTES) {
      throw new SecretBoxError("open");
    }
    try {
      const bytes = Buffer.from(sealed.ciphertext);
      const decipher = createDecipheriv(ALGORITHM, key, bytes.subarray(0, IV_BYTES), { authTagLength: TAG_BYTES });
      decipher.setAAD(aad);
      decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
      return new Uint8Array(Buffer.concat([decipher.update(bytes.subarray(IV_BYTES, bytes.length - TAG_BYTES)), decipher.final()]));
    } catch {
      throw new SecretBoxError("open");
    }
  }

  return {
    available: true,
    seal: (plaintext, sealOptions) => settle(() => seal(plaintext, sealOptions)),
    open: (sealed, sealOptions) => settle(() => open(sealed, sealOptions)),
    needsRotation: (keyId) => Promise.resolve(keyId !== currentKeyId),
    reseal: (sealed, sealOptions) =>
      settle(() => {
        const plaintext = open(sealed, sealOptions);
        try {
          return seal(plaintext, sealOptions);
        } finally {
          plaintext.fill(0);
        }
      }),
  };
}

function settle<T>(run: () => T): Promise<T> {
  try {
    return Promise.resolve(run());
  } catch (error) {
    return Promise.reject(error instanceof SecretBoxError ? error : new SecretBoxError("open"));
  }
}
