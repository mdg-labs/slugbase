import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checksumsRule } from "../../src/check/checksums.ts";
import { checksumOf, readChecksums, readJournal } from "../../src/check/migration-files.ts";
import { PACKAGE, PackageCopy } from "../check/package-copy.ts";
import { RELEASED_DIRECTORY, readSnapshotRecords } from "./read-back.ts";

// What each snapshot's record ties it to (doc 08 section 3.4): the compressed dump as committed, and the migrations of the chain it was
// taken at, by the checksums that `pnpm db:check` holds every merged migration to. A snapshot taken against a migration that was
// edited afterwards, or a dump replaced by hand, fails here, and an edited migration fails the checksum rule of `pnpm db:check`.

const journal = readJournal(PACKAGE).map((entry) => entry.tag);
const checksums = readChecksums(PACKAGE).migrations;
const copies: PackageCopy[] = [];

afterAll(() => {
  for (const copy of copies) {
    copy.remove();
  }
});

describe("the snapshot records", () => {
  const records = readSnapshotRecords();

  it("exist", () => {
    expect(records.length).toBeGreaterThan(0);
  });

  for (const record of records) {
    describe(record.tag, () => {
      it("names a dump with the recorded checksum", () => {
        const dump = readFileSync(join(RELEASED_DIRECTORY, record.file));
        expect(createHash("sha256").update(dump).digest("hex")).toBe(record.fileSha256);
      });

      it("were taken at a migration that the journal still lists in the same place, with the checksum recorded for it", () => {
        expect(journal[record.migrationCount - 1]).toBe(record.lastMigration);
        expect(record.lastMigrationSha256).toBe(checksums[record.lastMigration]);
      });

      it("hold the checksum of the whole chain up to that migration", () => {
        const lines = journal.slice(0, record.migrationCount).map((tag) => `${tag} ${checksums[tag] ?? "unrecorded"}`);
        expect(createHash("sha256").update(`${lines.join("\n")}\n`).digest("hex")).toBe(record.chainSha256);
      });

      it("fail the checksum rule of db:check once a migration the snapshot contains is edited", async () => {
        const copy = new PackageCopy();
        copies.push(copy);
        const file = join("migrations", `${record.lastMigration}.sql`);
        const edited = `${copy.read(file)}\n-- edited after the snapshot was taken\n`;
        copy.write(edited, file);
        const findings = await checksumsRule.run({ packageDir: copy.dir, sql: undefined, hashSqlFiles: () => "" });
        expect(findings).toHaveLength(1);
        expect(findings[0]?.object).toBe(`migrations/${record.lastMigration}.sql`);
        expect(findings[0]?.message).toContain("changed after it was recorded");
        expect(checksumOf(edited)).not.toBe(record.lastMigrationSha256);
      });
    });
  }
});
