import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const TOKEN_BYTES = 32;

export function generateOpaqueToken(): string {
  return randomBytes(TOKEN_BYTES).toString("hex");
}

export function hashOpaqueToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

export function verifyOpaqueToken(plaintext: string, expectedHash: string): boolean {
  const actual = hashOpaqueToken(plaintext);
  const actualBuf = Buffer.from(actual, "hex");
  const expectedBuf = Buffer.from(expectedHash, "hex");
  if (actualBuf.length !== expectedBuf.length) {
    return false;
  }
  return timingSafeEqual(actualBuf, expectedBuf);
}
