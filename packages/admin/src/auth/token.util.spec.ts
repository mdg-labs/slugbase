import { describe, expect, it } from "vitest";

import {
  generateOpaqueToken,
  hashOpaqueToken,
  verifyOpaqueToken,
} from "./token.util.js";

describe("opaque token utils", () => {
  it("generates unique tokens and stable SHA-256 hashes", () => {
    const tokenA = generateOpaqueToken();
    const tokenB = generateOpaqueToken();
    expect(tokenA).not.toBe(tokenB);
    expect(tokenA).toHaveLength(64);

    const hash = hashOpaqueToken(tokenA);
    expect(hash).toHaveLength(64);
    expect(verifyOpaqueToken(tokenA, hash)).toBe(true);
    expect(verifyOpaqueToken(tokenB, hash)).toBe(false);
  });
});
