import { randomBytes } from "node:crypto";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import type { SealedSecret, SecretBoxPort } from "@slugbase/core";
import { SecretBoxError, createSecretBox } from "../src/index.ts";

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const hex = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, "hex"));

const K1 = { keyId: "k1", key: randomBytes(32) };
const K2 = { keyId: "k2", key: randomBytes(32) };
const AAD = text("mfa_secrets.secret:0190e5a0-0000-7000-8000-000000000001");
const SECRET = text("JBSWY3DPEHPK3PXP-plaintext-sentinel");

function box(current = K1, previous: typeof K1[] = []): SecretBoxPort {
  return createSecretBox({ current, previous });
}

async function failure(run: () => Promise<unknown>): Promise<SecretBoxError> {
  const error = await run().then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(SecretBoxError);
  return error as SecretBoxError;
}

describe("seal and open", () => {
  it("round trips and reports the key id of the current key", async () => {
    const secretBox = box();
    expect(secretBox.available).toBe(true);
    const sealed = await secretBox.seal(SECRET, { aad: AAD });
    expect(sealed.keyId).toBe("k1");
    expect(await secretBox.open(sealed, { aad: AAD })).toEqual(SECRET);
  });

  it("round trips an empty plaintext", async () => {
    const secretBox = box();
    const sealed = await secretBox.seal(new Uint8Array(), { aad: AAD });
    expect(await secretBox.open(sealed, { aad: AAD })).toEqual(new Uint8Array());
  });

  it("lays a sealed value out as iv, encrypted bytes and tag, with no plaintext in it", async () => {
    const sealed = await box().seal(SECRET, { aad: AAD });
    expect(sealed.ciphertext.length).toBe(12 + SECRET.length + 16);
    expect(Buffer.from(sealed.ciphertext).includes(Buffer.from(SECRET))).toBe(false);
  });

  // GCM test case 16 (McGrew and Viega, "The Galois/Counter Mode of Operation"): AES-256, a 96-bit IV, 60
  // bytes of plaintext and 20 bytes of additional data. The stored form is the IV, the ciphertext and the tag.
  it("opens the known-answer vector of AES-256-GCM", async () => {
    const key = hex("feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308");
    const stored = new Uint8Array(
      Buffer.concat([
        hex("cafebabefacedbaddecaf888"),
        hex(
          "522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662",
        ),
        hex("76fc6ece0f4e1768cddf8853bb2d551b"),
      ]),
    );
    const plaintext = hex(
      "d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39",
    );
    const aad = hex("feedfacedeadbeeffeedfacedeadbeefabaddad2");
    const secretBox = createSecretBox({ current: { keyId: "kat", key } });
    expect(await secretBox.open({ ciphertext: stored, keyId: "kat" }, { aad })).toEqual(plaintext);
    await failure(() => secretBox.open({ ciphertext: stored, keyId: "kat" }, { aad: hex("feedfacedeadbeeffeedfacedeadbeefabaddad3") }));
  });

  it("fails to open when any single byte of the sealed value is flipped", async () => {
    const secretBox = box();
    const sealed = await secretBox.seal(SECRET, { aad: AAD });
    for (let index = 0; index < sealed.ciphertext.length; index += 1) {
      const flipped = new Uint8Array(sealed.ciphertext);
      flipped[index] = (flipped[index] ?? 0) ^ 0x01;
      await failure(() => secretBox.open({ ciphertext: flipped, keyId: sealed.keyId }, { aad: AAD }));
    }
  });

  it("fails to open a truncated or extended value", async () => {
    const secretBox = box();
    const sealed = await secretBox.seal(SECRET, { aad: AAD });
    for (const ciphertext of [
      new Uint8Array(),
      sealed.ciphertext.subarray(0, 27),
      sealed.ciphertext.subarray(0, sealed.ciphertext.length - 1),
      new Uint8Array(Buffer.concat([sealed.ciphertext, Buffer.from([0])])),
    ]) {
      await failure(() => secretBox.open({ ciphertext, keyId: sealed.keyId }, { aad: AAD }));
    }
  });

  it("fails to open under a key id that is not the one it was sealed with", async () => {
    const secretBox = box(K1, [K2]);
    const sealed = await secretBox.seal(SECRET, { aad: AAD });
    await failure(() => secretBox.open({ ...sealed, keyId: "k2" }, { aad: AAD }));
    await failure(() => secretBox.open({ ...sealed, keyId: "unknown" }, { aad: AAD }));
  });

  it("fails to open with other additional data: a value copied to another column or row", async () => {
    const secretBox = box();
    const sealed = await secretBox.seal(SECRET, { aad: AAD });
    await failure(() => secretBox.open(sealed, { aad: text("mfa_secrets.recovery:0190e5a0-0000-7000-8000-000000000001") }));
    await failure(() => secretBox.open(sealed, { aad: text("mfa_secrets.secret:0190e5a0-0000-7000-8000-000000000002") }));
  });

  it("refuses empty additional data, which would bind the value to nothing", async () => {
    const secretBox = box();
    await failure(() => secretBox.seal(SECRET, { aad: new Uint8Array() }));
    const sealed = await secretBox.seal(SECRET, { aad: AAD });
    await failure(() => secretBox.open(sealed, { aad: new Uint8Array() }));
  });

  it("cannot be opened by a box that does not hold the key (a database dump without the key)", async () => {
    const sealed = await box().seal(SECRET, { aad: AAD });
    await failure(() => box({ keyId: "k1", key: randomBytes(32) }).open(sealed, { aad: AAD }));
  });

  it("never reuses an IV across 10 000 seals of one value", async () => {
    const secretBox = box();
    const ivs = new Set<string>();
    for (let count = 0; count < 10_000; count += 1) {
      const sealed = await secretBox.seal(SECRET, { aad: AAD });
      ivs.add(Buffer.from(sealed.ciphertext.subarray(0, 12)).toString("hex"));
    }
    expect(ivs.size).toBe(10_000);
  });
});

describe("rotation", () => {
  it("opens a value sealed with K1 under K2 current and K1 previous, then reseals it under K2", async () => {
    const sealedUnderK1 = await box(K1).seal(SECRET, { aad: AAD });
    const rotated = box(K2, [K1]);

    expect(await rotated.open(sealedUnderK1, { aad: AAD })).toEqual(SECRET);
    expect(await rotated.needsRotation(sealedUnderK1.keyId)).toBe(true);

    const resealed = await rotated.reseal(sealedUnderK1, { aad: AAD });
    expect(resealed.keyId).toBe("k2");
    expect(await rotated.needsRotation(resealed.keyId)).toBe(false);
    expect(await rotated.open(resealed, { aad: AAD })).toEqual(SECRET);
    expect(resealed.ciphertext).not.toEqual(sealedUnderK1.ciphertext);

    await failure(() => box(K1).open(resealed, { aad: AAD }));
    expect(await box(K2).open(resealed, { aad: AAD })).toEqual(SECRET);
  });

  it("needs rotation for any key id other than the current one", async () => {
    const secretBox = box(K2, [K1]);
    expect(await secretBox.needsRotation("k2")).toBe(false);
    expect(await secretBox.needsRotation("k1")).toBe(true);
    expect(await secretBox.needsRotation("never-configured")).toBe(true);
  });

  it("seals only under the current key, never a previous one", async () => {
    const sealed = await box(K2, [K1]).seal(SECRET, { aad: AAD });
    expect(sealed.keyId).toBe("k2");
    await failure(() => box(K1).open(sealed, { aad: AAD }));
  });

  it("does not open a value sealed under a key that was dropped from the previous keys", async () => {
    const sealedUnderK1 = await box(K1).seal(SECRET, { aad: AAD });
    await failure(() => box(K2).open(sealedUnderK1, { aad: AAD }));
  });

  it("reseals only with the additional data the value was sealed with", async () => {
    const sealedUnderK1 = await box(K1).seal(SECRET, { aad: AAD });
    await failure(() => box(K2, [K1]).reseal(sealedUnderK1, { aad: text("other.column:row") }));
  });
});

describe("configuration", () => {
  it.each([
    ["a key of 31 bytes", { current: { keyId: "k1", key: randomBytes(31) } }],
    ["a key of 33 bytes", { current: { keyId: "k1", key: randomBytes(33) } }],
    ["a previous key of 16 bytes", { current: K1, previous: [{ keyId: "old", key: randomBytes(16) }] }],
    ["an empty key id", { current: { keyId: "", key: randomBytes(32) } }],
    ["a previous key with the id of the current key", { current: K1, previous: [{ keyId: "k1", key: randomBytes(32) }] }],
    ["two previous keys with one id", { current: K1, previous: [{ ...K2 }, { keyId: "k2", key: randomBytes(32) }] }],
  ])("refuses %s", (_name, options) => {
    expect(() => createSecretBox(options)).toThrow(SecretBoxError);
    try {
      createSecretBox(options);
    } catch (error) {
      expect(error).toMatchObject({ operation: "configure" });
    }
  });
});

describe("errors (T7)", () => {
  it("are generic: no plaintext, key material, key id, additional data or ciphertext", async () => {
    const secretBox = box(K2, [K1]);
    const sealed = await secretBox.seal(SECRET, { aad: AAD });
    const flipped = new Uint8Array(sealed.ciphertext);
    flipped[20] = (flipped[20] ?? 0) ^ 0xff;
    const failures: SecretBoxError[] = [
      await failure(() => secretBox.open({ ciphertext: flipped, keyId: "k2" }, { aad: AAD })),
      await failure(() => secretBox.open(sealed, { aad: text("other") })),
      await failure(() => secretBox.open({ ...sealed, keyId: "secret-key-id-sentinel" }, { aad: AAD })),
      await failure(() => secretBox.seal(SECRET, { aad: new Uint8Array() })),
      await failure(() => secretBox.reseal({ ...sealed, keyId: "secret-key-id-sentinel" }, { aad: AAD })),
    ];
    try {
      createSecretBox({ current: { keyId: "config-key-id-sentinel", key: randomBytes(5) } });
    } catch (error) {
      failures.push(error as SecretBoxError);
    }
    const forbidden = [
      Buffer.from(SECRET).toString(),
      Buffer.from(SECRET).toString("base64"),
      Buffer.from(AAD).toString(),
      Buffer.from(K1.key).toString("base64"),
      Buffer.from(K1.key).toString("hex"),
      Buffer.from(K2.key).toString("base64"),
      Buffer.from(K2.key).toString("hex"),
      Buffer.from(flipped).toString("base64"),
      Buffer.from(flipped).toString("hex"),
      Buffer.from(sealed.ciphertext).toString("base64"),
      Buffer.from(sealed.ciphertext).toString("hex"),
      "secret-key-id-sentinel",
      "config-key-id-sentinel",
    ];
    expect(failures).toHaveLength(6);
    for (const error of failures) {
      const rendered = [inspect(error, { depth: null, showHidden: true }), JSON.stringify(error), error.message, error.stack ?? ""].join("\n");
      for (const value of forbidden) {
        expect(rendered).not.toContain(value);
      }
      expect(error.cause).toBeUndefined();
    }
    expect(failures[0]?.message).toBe("The secret box could not open");
    expect(failures[3]?.message).toBe("The secret box could not seal");
    expect(failures[5]?.message).toBe("The secret box could not be configured");
  });

  it("does not expose key material through the box", () => {
    const rendered = inspect(box(), { depth: null, showHidden: true });
    expect(rendered).not.toContain(Buffer.from(K1.key).toString("base64"));
    expect(rendered).not.toContain(Buffer.from(K1.key).toString("hex"));
  });
});

// T7: a database dump holds the ciphertext and the key id, never the key.
describe("failure scenario T7", () => {
  it("rejects a ciphertext swapped between rows, and gives a dump holder nothing without the key", async () => {
    const secretBox = box();
    const rowA = { aad: text("mfa_secrets.secret:row-a") };
    const rowB = { aad: text("mfa_secrets.secret:row-b") };
    const sealedA: SealedSecret = await secretBox.seal(text("secret of a"), rowA);
    const sealedB: SealedSecret = await secretBox.seal(text("secret of b"), rowB);

    expect(await secretBox.open(sealedA, rowA)).toEqual(text("secret of a"));
    await failure(() => secretBox.open(sealedA, rowB));
    await failure(() => secretBox.open(sealedB, rowA));

    for (let attempt = 0; attempt < 20; attempt += 1) {
      await failure(() => box({ keyId: "k1", key: randomBytes(32) }).open(sealedA, rowA));
    }
  });
});
