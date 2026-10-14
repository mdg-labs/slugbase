// Generates the breached-password range dataset shipped in packages/core/src/auth/breached/
// (doc 02 section 2.5, Q15). It reads the most common passwords from a local copy of the
// source list, keeps those the policy can still reject on content (12 to 256 characters), and
// writes the SHA-1 digests of the UTF-8 passwords, sorted and de-duplicated, as one file of
// 20-byte records. No password is written out, and nothing here makes a network request.
//
//   node scripts/generate-breached-passwords.mjs <source-list.txt> [output.bin]
//
// The source, its pinned revision and licence, and the steps to refresh the dataset for a
// release are in packages/core/src/auth/breached/NOTICE.md.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** SHA-256 of the source list at the pinned revision of NOTICE.md; a different file is refused. */
const SOURCE_SHA256 = "424a3e03a17df0a2bc2b3ca749d81b04e79d59cb7aeec8876a5a3f308d0caf51";
/** Only this many of the most common passwords are read. */
const SOURCE_ROWS = 1_000_000;
const MIN_LENGTH = 12;
const MAX_LENGTH = 256;
const DIGEST_BYTES = 20;

const DEFAULT_OUTPUT = fileURLToPath(new URL("../packages/core/src/auth/breached/breached-sha1.bin", import.meta.url));

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const [source, output = DEFAULT_OUTPUT] = process.argv.slice(2);
if (source === undefined) {
  fail("usage: node scripts/generate-breached-passwords.mjs <source-list.txt> [output.bin]");
}

const bytes = readFileSync(source);
const sha256 = createHash("sha256").update(bytes).digest("hex");
if (sha256 !== SOURCE_SHA256) {
  fail(`${source} is not the pinned source list (SHA-256 ${sha256}, expected ${SOURCE_SHA256}).`);
}

const digests = new Map();
let rows = 0;
for (const line of bytes.toString("utf8").split("\n")) {
  if (rows === SOURCE_ROWS) {
    break;
  }
  rows += 1;
  const password = line.endsWith("\r") ? line.slice(0, -1) : line;
  const length = Array.from(password).length;
  if (length < MIN_LENGTH || length > MAX_LENGTH) {
    continue;
  }
  const digest = createHash("sha1").update(password, "utf8").digest();
  digests.set(digest.toString("hex"), digest);
}

const sorted = [...digests.keys()].sort();
const file = Buffer.concat(sorted.map((key) => /** @type {Buffer} */ (digests.get(key))));
if (file.length !== sorted.length * DIGEST_BYTES || sorted.length === 0) {
  fail("The dataset came out empty or malformed.");
}
writeFileSync(output, file);
const digestOfFile = createHash("sha256").update(file).digest("hex");
process.stdout.write(`${sorted.length} passwords from the first ${rows} rows; ${file.length} bytes; SHA-256 ${digestOfFile}\n`);
