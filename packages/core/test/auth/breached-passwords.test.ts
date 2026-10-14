import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BreachedDatasetError, createBreachedPasswords, loadBreachedPasswords } from "../../src/auth/breached/index.ts";

const RECORD = 20;

function digest(password: string): Buffer {
  return createHash("sha1").update(password, "utf8").digest();
}

describe("the shipped dataset", () => {
  const file = readFileSync(new URL("../../src/auth/breached/breached-sha1.bin", import.meta.url));

  it("is sorted 20-byte records without duplicates, which the loader checks", () => {
    expect(file.length).toBeGreaterThan(0);
    expect(file.length % RECORD).toBe(0);
    for (let at = RECORD; at < file.length; at += RECORD) {
      expect(Buffer.compare(file.subarray(at - RECORD, at), file.subarray(at, at + RECORD))).toBeLessThan(0);
    }
    expect(loadBreachedPasswords()).toBe(loadBreachedPasswords());
  });

  it("holds the digest of a common long password and answers by its range", () => {
    const breached = loadBreachedPasswords();
    const hex = digest("123qweasdzxc").toString("hex").toUpperCase();
    expect(breached.has("123qweasdzxc")).toBe(true);
    expect(breached.range(hex.slice(0, 5))).toContain(hex.slice(5));
    expect(breached.has("123qweasdzxc!")).toBe(false);
  });
});

describe("createBreachedPasswords", () => {
  const sorted = ["alpha password", "bravo password", "charlie password"]
    .map(digest)
    .sort((left, right) => Buffer.compare(left, right));

  it("returns the 35-character suffixes of one 5-character prefix, uppercase, and no other", () => {
    const breached = createBreachedPasswords(Buffer.concat(sorted));
    const hex = sorted[1]?.toString("hex").toUpperCase() ?? "";
    expect(breached.range(hex.slice(0, 5))).toEqual([hex.slice(5)]);
    expect(breached.range(hex.slice(0, 5).toLowerCase())).toEqual([hex.slice(5)]);
    expect(breached.range("00000")).toEqual([]);
    expect(breached.range("FFFFF")).toEqual([]);
  });

  it("collects every record of a range that holds several", () => {
    const first = Buffer.alloc(RECORD, 0);
    const second = Buffer.alloc(RECORD, 0);
    second[RECORD - 1] = 1;
    const other = Buffer.alloc(RECORD, 0);
    other[0] = 1;
    const breached = createBreachedPasswords(Buffer.concat([first, second, other]));
    expect(breached.range("00000")).toEqual(["0".repeat(35), `${"0".repeat(34)}1`]);
    expect(breached.range("01000")).toEqual(["0".repeat(35)]);
  });

  it("refuses a malformed prefix", () => {
    const breached = createBreachedPasswords(Buffer.concat(sorted));
    expect(() => breached.range("ABCD")).toThrow(RangeError);
    expect(() => breached.range("ABCDEG")).toThrow(RangeError);
  });

  it.each([
    ["an empty file", Buffer.alloc(0)],
    ["a size that is not a multiple of 20", Buffer.alloc(RECORD + 1, 1)],
    ["records out of order", Buffer.concat([...sorted].reverse())],
    ["a duplicate record", Buffer.concat([sorted[0] ?? Buffer.alloc(0), sorted[0] ?? Buffer.alloc(0)])],
  ])("refuses %s instead of answering that nothing is breached", (_name, records) => {
    expect(() => createBreachedPasswords(records)).toThrow(BreachedDatasetError);
  });
});

describe("loadBreachedPasswords", () => {
  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.resetModules();
  });

  async function loadWith(read: () => Buffer) {
    vi.resetModules();
    vi.doMock("node:fs", async (importOriginal) => ({ ...(await importOriginal<typeof import("node:fs")>()), readFileSync: read }));
    return import("../../src/auth/breached/breached-passwords.ts");
  }

  it("throws a BreachedDatasetError when the file cannot be read, and tries again on the next call", async () => {
    let failing = true;
    const module = await loadWith(() => {
      if (failing) {
        throw new Error("ENOENT");
      }
      return Buffer.concat([digest("a listed password")]);
    });
    expect(() => module.loadBreachedPasswords()).toThrow(module.BreachedDatasetError);
    failing = false;
    expect(module.loadBreachedPasswords().has("a listed password")).toBe(true);
  });

  it("throws when the file read is empty", async () => {
    const module = await loadWith(() => Buffer.alloc(0));
    expect(() => module.loadBreachedPasswords()).toThrow(module.BreachedDatasetError);
  });
});
