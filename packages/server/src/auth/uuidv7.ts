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

/**
 * A generator of UUIDv7 whose identifiers ascend with every call: the millisecond of each is greater than the last one's, even when the clock has not moved or has stepped back, so rows
 * inserted with them list in the order of the calls (a UUIDv7 is random within a millisecond). The millisecond runs ahead of the clock for as long as calls come faster than one a millisecond.
 */
export function ascendingUuidv7(now: () => number = Date.now): () => string {
  let last = 0;
  return () => {
    last = Math.max(now(), last + 1);
    return uuidv7(last);
  };
}
