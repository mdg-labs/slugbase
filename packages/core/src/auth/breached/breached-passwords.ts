import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// The breached-password check (doc 02 section 2.5, Q15) reads a dataset shipped with the package
// and makes no network request. The dataset is the sorted SHA-1 digests of the passwords, in
// 20-byte records (see NOTICE.md); a lookup works the way the range API of the Pwned Passwords
// service does: by the first five hexadecimal characters of the digest, then by the rest.

const DIGEST_BYTES = 20;
const PREFIX_LENGTH = 5;
const SUFFIX_LENGTH = DIGEST_BYTES * 2 - PREFIX_LENGTH;

/** The dataset is missing, empty or not the sorted records it should be. */
export class BreachedDatasetError extends Error {
  constructor(reason: string) {
    super(`The breached-password dataset cannot be used: ${reason}.`);
    this.name = "BreachedDatasetError";
  }
}

export interface BreachedPasswords {
  /** The uppercase hexadecimal suffixes (35 characters) of the digests that start with `prefix`, 5 hexadecimal characters. */
  range(prefix: string): readonly string[];
  /** Whether the password is in the dataset; it is hashed as typed, with no normalisation, and compared within its range. */
  has(password: string): boolean;
}

/** The first 20 bits of the digest at `index`, which is the range prefix as a number. */
function prefixAt(records: Uint8Array, index: number): number {
  const at = index * DIGEST_BYTES;
  return ((records[at] ?? 0) << 12) | ((records[at + 1] ?? 0) << 4) | ((records[at + 2] ?? 0) >> 4);
}

function compareRecords(records: Uint8Array, left: number, right: number): number {
  for (let offset = 0; offset < DIGEST_BYTES; offset += 1) {
    const difference = (records[left * DIGEST_BYTES + offset] ?? 0) - (records[right * DIGEST_BYTES + offset] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

/**
 * A lookup over `records`, the digests as sorted 20-byte records without duplicates. Anything else
 * is refused: a dataset that cannot be searched would answer "not breached" for every password.
 */
export function createBreachedPasswords(records: Uint8Array): BreachedPasswords {
  if (records.length === 0) {
    throw new BreachedDatasetError("it holds no record");
  }
  if (records.length % DIGEST_BYTES !== 0) {
    throw new BreachedDatasetError(`its size is not a multiple of ${String(DIGEST_BYTES)} bytes`);
  }
  const count = records.length / DIGEST_BYTES;
  for (let index = 1; index < count; index += 1) {
    if (compareRecords(records, index - 1, index) >= 0) {
      throw new BreachedDatasetError("its records are not sorted without duplicates");
    }
  }

  const range = (prefix: string): readonly string[] => {
    if (!/^[0-9A-Fa-f]{5}$/.test(prefix)) {
      throw new RangeError("A range prefix is 5 hexadecimal characters.");
    }
    const wanted = Number.parseInt(prefix, 16);
    let low = 0;
    let high = count;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (prefixAt(records, middle) < wanted) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    const suffixes: string[] = [];
    for (let index = low; index < count && prefixAt(records, index) === wanted; index += 1) {
      const digest = Buffer.from(records.buffer, records.byteOffset + index * DIGEST_BYTES, DIGEST_BYTES);
      suffixes.push(digest.toString("hex").toUpperCase().slice(PREFIX_LENGTH));
    }
    return suffixes;
  };

  return {
    range,
    has(password) {
      const digest = createHash("sha1").update(password, "utf8").digest("hex").toUpperCase();
      const suffix = digest.slice(PREFIX_LENGTH);
      return suffix.length === SUFFIX_LENGTH && range(digest.slice(0, PREFIX_LENGTH)).includes(suffix);
    },
  };
}

let shipped: BreachedPasswords | undefined;

/**
 * The dataset shipped next to this module, read once per process. It throws a
 * {@link BreachedDatasetError} when the file is missing or unusable, so a deployment that has the
 * check on refuses to start instead of accepting every password as unlisted.
 */
export function loadBreachedPasswords(): BreachedPasswords {
  if (shipped === undefined) {
    let records: Buffer;
    try {
      records = readFileSync(new URL("./breached-sha1.bin", import.meta.url));
    } catch {
      throw new BreachedDatasetError("it cannot be read");
    }
    shipped = createBreachedPasswords(records);
  }
  return shipped;
}
