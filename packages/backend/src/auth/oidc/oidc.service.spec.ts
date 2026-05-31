import { describe, expect, it } from "vitest";
import { calculatePKCECodeChallenge, randomNonce, randomPKCECodeVerifier, randomState } from "openid-client";

describe("OIDC state / nonce generation uniqueness", () => {
  it("generates unique state values across multiple calls", () => {
    const values = new Set(Array.from({ length: 50 }, () => randomState()));
    expect(values.size).toBe(50);
  });

  it("generates state values with sufficient entropy (>= 32 chars base64url)", () => {
    const state = randomState();
    expect(state.length).toBeGreaterThanOrEqual(32);
  });

  it("generates unique nonce values across multiple calls", () => {
    const values = new Set(Array.from({ length: 50 }, () => randomNonce()));
    expect(values.size).toBe(50);
  });

  it("generates nonce values with sufficient entropy (>= 32 chars base64url)", () => {
    const nonce = randomNonce();
    expect(nonce.length).toBeGreaterThanOrEqual(32);
  });

  it("state and nonce are different values", () => {
    const state = randomState();
    const nonce = randomNonce();
    expect(state).not.toBe(nonce);
  });
});

describe("OIDC PKCE S256 verifier/challenge pair", () => {
  it("generates a unique code_verifier each call", () => {
    const verifiers: string[] = [];
    for (let i = 0; i < 20; i++) {
      verifiers.push(randomPKCECodeVerifier());
    }
    const unique = new Set(verifiers);
    expect(unique.size).toBe(20);
  });

  it("code_verifier meets RFC 7636 length requirement (43–128 chars)", () => {
    const verifier = randomPKCECodeVerifier();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
  });

  it("code_verifier contains only unreserved characters (RFC 7636)", () => {
    const verifier = randomPKCECodeVerifier();
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  it("calculates a deterministic code_challenge from a given verifier", async () => {
    const verifier = randomPKCECodeVerifier();
    const challenge1 = await calculatePKCECodeChallenge(verifier);
    const challenge2 = await calculatePKCECodeChallenge(verifier);
    expect(challenge1).toBe(challenge2);
  });

  it("different verifiers produce different challenges", async () => {
    const v1 = randomPKCECodeVerifier();
    const v2 = randomPKCECodeVerifier();
    const [c1, c2] = await Promise.all([
      calculatePKCECodeChallenge(v1),
      calculatePKCECodeChallenge(v2),
    ]);
    expect(c1).not.toBe(c2);
  });

  it("code_challenge is base64url-encoded SHA-256 (43 chars without padding)", async () => {
    const verifier = randomPKCECodeVerifier();
    const challenge = await calculatePKCECodeChallenge(verifier);
    // Base64url-encoded SHA-256 (32 bytes) without padding = 43 chars
    expect(challenge.length).toBe(43);
    expect(challenge).toMatch(/^[A-Za-z0-9\-_]+$/);
  });
});
