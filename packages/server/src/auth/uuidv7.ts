import { randomBytes } from "node:crypto";

const VERSION_7 = 0x70;
const VARIANT_RFC_9562 = 0x80;

/**
 * A UUIDv7 (RFC 9562): 48 bits of Unix time in milliseconds, then random bits.
 * Identifiers are generated in the application and never by the database (Q91),
 * and a time-ordered one keeps the primary-key index append-mostly.
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(now, 0, 6);
  bytes[6] = VERSION_7 | ((bytes[6] ?? 0) & 0x0f);
  bytes[8] = VARIANT_RFC_9562 | ((bytes[8] ?? 0) & 0x3f);
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
