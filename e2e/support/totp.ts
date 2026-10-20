import { createHmac } from "node:crypto";

// The authenticator app of the journeys: RFC 6238 codes (HMAC-SHA-1, 6 digits, 30 second steps), the
// algorithm every authenticator app implements and the one the server verifies against. It is written
// out here, not imported from packages/core, so that the journeys check the server against the
// standard and not against its own code.

const PERIOD_SECONDS = 30;
const DIGITS = 6;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** The bytes of an RFC 4648 base32 text key, as an authenticator app reads it; spaces and padding are ignored. */
export function base32Decode(key: string): Buffer {
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const character of key.toUpperCase().replace(/[\s=]/g, "")) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) {
      throw new Error("the setup key is not base32");
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
      value &= (1 << bits) - 1;
    }
  }
  return Buffer.from(bytes);
}

/** The time step an instant falls in. */
export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / PERIOD_SECONDS);
}

/** The code of a time step for a setup key. */
export function totpCode(key: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", base32Decode(key)).update(counter).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}
