import {
  CHECKSUM_FILE,
  checksumOf,
  migrationFileTags,
  readChecksums,
  readJournal,
  readMigration,
} from "./migration-files.ts";
import type { CheckRule, Finding } from "./types.ts";

// Doc 05 section 5.1: a migration file is committed only as the generator's
// output and never edited once merged, so each file matches the checksum
// recorded when it was first committed.

const ID = "migration-checksums";

export const checksumsRule: CheckRule = {
  id: ID,
  description: "every migration file matches the checksum recorded when it was first committed",
  run({ packageDir }) {
    const journal = readJournal(packageDir);
    const recorded = readChecksums(packageDir).migrations;
    const findings: Finding[] = [];
    const listed = new Set<string>();
    for (const { tag } of journal) {
      listed.add(tag);
      const object = `migrations/${tag}.sql`;
      const content = readMigration(packageDir, tag);
      if (content === undefined) {
        findings.push({ rule: ID, object, message: "is listed in the journal but cannot be read" });
        continue;
      }
      const expected = recorded[tag];
      if (expected === undefined) {
        findings.push({
          rule: ID,
          object,
          message: `has no recorded checksum in ${CHECKSUM_FILE}: run pnpm db:record-checksums`,
        });
      } else if (expected !== checksumOf(content)) {
        findings.push({
          rule: ID,
          object,
          message: `changed after it was recorded (sha256 ${expected.slice(0, 12)}, now ${checksumOf(content).slice(0, 12)}); a merged migration is never edited, add a new one`,
        });
      }
    }
    for (const tag of Object.keys(recorded)) {
      if (!listed.has(tag)) {
        findings.push({
          rule: ID,
          object: `migrations/${tag}.sql`,
          message: `is recorded in ${CHECKSUM_FILE} but the journal does not list it`,
        });
      }
    }
    for (const tag of migrationFileTags(packageDir)) {
      if (!listed.has(tag)) {
        findings.push({
          rule: ID,
          object: `migrations/${tag}.sql`,
          message: "is not listed in the journal, so migrate would never apply it",
        });
      }
    }
    return findings;
  },
};
