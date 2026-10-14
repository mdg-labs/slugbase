import { createHash } from "node:crypto";
import { FakeEgress } from "@slugbase/testing-ports";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBreachedPasswords, loadBreachedPasswords } from "../../src/auth/breached/index.ts";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, createPasswordPolicy } from "../../src/auth/password-policy.ts";

/** A dataset of exactly these passwords, in the sorted 20-byte records the shipped one has. */
function datasetOf(...passwords: string[]) {
  const digests = passwords.map((password) => createHash("sha1").update(password, "utf8").digest("hex")).sort();
  return createBreachedPasswords(Buffer.from(digests.join(""), "hex"));
}

const LISTED = "listed password 1";
const lengthOnly = createPasswordPolicy();
const withDataset = createPasswordPolicy({ breached: datasetOf(LISTED, "another listed one") });

describe("the length rules", () => {
  it("accepts a password of 12 to 256 characters", () => {
    expect(PASSWORD_MIN_LENGTH).toBe(12);
    expect(PASSWORD_MAX_LENGTH).toBe(256);
    expect(lengthOnly.check("a".repeat(12))).toEqual([]);
    expect(lengthOnly.check("a".repeat(256))).toEqual([]);
  });

  it("refuses 11 characters as too short and 257 as too long", () => {
    expect(lengthOnly.check("a".repeat(11))).toEqual(["too_short"]);
    expect(lengthOnly.check("")).toEqual(["too_short"]);
    expect(lengthOnly.check("a".repeat(257))).toEqual(["too_long"]);
    expect(lengthOnly.check("a".repeat(100_000))).toEqual(["too_long"]);
  });

  it("counts a character outside the Basic Multilingual Plane once", () => {
    expect(lengthOnly.check("\u{1F511}".repeat(12))).toEqual([]);
    expect(lengthOnly.check("\u{1F511}".repeat(11))).toEqual(["too_short"]);
    expect(lengthOnly.check("\u{1F511}".repeat(256))).toEqual([]);
    expect(lengthOnly.check("\u{1F511}".repeat(257))).toEqual(["too_long"]);
  });

  it("applies no composition rule and does not trim", () => {
    expect(lengthOnly.check("            ")).toEqual([]);
    expect(lengthOnly.check("aaaaaaaaaaaa")).toEqual([]);
  });

  it("still applies with the shipped dataset", () => {
    const policy = createPasswordPolicy({ breached: loadBreachedPasswords() });
    expect(policy.check("short")).toEqual(["too_short"]);
    expect(policy.check("a".repeat(257))).toEqual(["too_long"]);
  });
});

describe("the breached rule", () => {
  it("refuses a listed password as breached and accepts one that is not listed", () => {
    expect(withDataset.check(LISTED)).toEqual(["breached"]);
    expect(withDataset.check("another listed one")).toEqual(["breached"]);
    expect(withDataset.check("not listed anywhere")).toEqual([]);
  });

  it("compares the password as typed", () => {
    expect(withDataset.check(LISTED.toUpperCase())).toEqual([]);
    expect(withDataset.check(`${LISTED} `)).toEqual([]);
  });

  it("is left out when no dataset is given", () => {
    expect(lengthOnly.check(LISTED)).toEqual([]);
  });

  it("judges length before the dataset", () => {
    expect(createPasswordPolicy({ breached: datasetOf("short") }).check("short")).toEqual(["too_short"]);
  });

  it("refuses passwords of the shipped dataset and accepts a random one", () => {
    const policy = createPasswordPolicy({ breached: loadBreachedPasswords() });
    expect(policy.check("123qweasdzxc")).toEqual(["breached"]);
    expect(policy.check("1qaz2wsx3edc")).toEqual(["breached"]);
    expect(policy.check("kV3x-Q9pWz1-mT7s-Lh4u")).toEqual([]);
  });
});

describe("the check makes no outbound request", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("checking a listed and an unlisted password calls neither global fetch nor the egress port", () => {
    const egress = new FakeEgress();
    const refuse = (): never => {
      throw new Error("a network call was made");
    };
    const fetchCalls = vi.spyOn(globalThis, "fetch").mockImplementation(refuse);

    const policy = createPasswordPolicy({ breached: loadBreachedPasswords() });
    expect(policy.check("123qweasdzxc")).toEqual(["breached"]);
    expect(policy.check("kV3x-Q9pWz1-mT7s-Lh4u")).toEqual([]);

    expect(fetchCalls).not.toHaveBeenCalled();
    expect(egress.requests).toHaveLength(0);
  });
});
