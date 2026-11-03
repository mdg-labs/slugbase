import { afterEach, describe, expect, it, vi } from "vitest";
import { newIdempotencyKey } from "../src/api/idempotency-key.ts";

// The shared idempotency key of the import wizard and the invite dialog. The failure scenarios are a key that the server's
// UUID check refuses, two requests that draw the same key, and a key that needs `crypto.randomUUID`, which a self-hosted
// instance served over plain http does not have.

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("a new idempotency key", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is a version 4 UUID and differs on every call", () => {
    const keys = Array.from({ length: 64 }, () => newIdempotencyKey());
    for (const key of keys) {
      expect(key).toMatch(UUID_V4);
    }
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("is made outside a secure context, where crypto.randomUUID is missing", () => {
    const real = globalThis.crypto;
    vi.stubGlobal("crypto", { getRandomValues: (array: Uint8Array<ArrayBuffer>) => real.getRandomValues(array) });
    expect(newIdempotencyKey()).toMatch(UUID_V4);
  });
});
