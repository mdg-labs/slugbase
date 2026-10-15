import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { SealedSecret, SecretBoxOptions, SecretBoxPort } from "@slugbase/core";

// A secret box for the tests of the server, which does not depend on the adapters package: AES-256-GCM over
// `iv || ciphertext || tag` with the additional data bound, as the adapter writes it, under the keys given. The
// first key seals; every key opens, so a test rotates by building a second box whose first key is a new one.

export interface TestKey {
  readonly keyId: string;
  readonly key: Buffer;
}

export function testKey(keyId: string): TestKey {
  return { keyId, key: randomBytes(32) };
}

export function testSecretBox(...keys: [TestKey, ...TestKey[]]): SecretBoxPort {
  const [current] = keys;
  const byId = new Map(keys.map((entry) => [entry.keyId, entry.key]));

  const seal = (plaintext: Uint8Array, { aad }: SecretBoxOptions): SealedSecret => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", current.key, iv);
    cipher.setAAD(aad);
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { ciphertext: new Uint8Array(Buffer.concat([iv, body, cipher.getAuthTag()])), keyId: current.keyId };
  };
  const open = ({ ciphertext, keyId }: SealedSecret, { aad }: SecretBoxOptions): Uint8Array => {
    const key = byId.get(keyId);
    if (key === undefined) {
      throw new Error("the test secret box has no such key");
    }
    const bytes = Buffer.from(ciphertext);
    const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
    decipher.setAAD(aad);
    decipher.setAuthTag(bytes.subarray(bytes.length - 16));
    return new Uint8Array(Buffer.concat([decipher.update(bytes.subarray(12, bytes.length - 16)), decipher.final()]));
  };

  return {
    available: true,
    seal: (plaintext, options) => Promise.resolve(seal(plaintext, options)),
    open: (sealed, options) => Promise.resolve(open(sealed, options)),
    needsRotation: (keyId) => Promise.resolve(keyId !== current.keyId),
    reseal: (sealed, options) => Promise.resolve(seal(open(sealed, options), options)),
  };
}
