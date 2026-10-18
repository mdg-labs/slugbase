import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  autoCreateAllowed,
  bindOidcState,
  federatedDisplayName,
  hashOidcState,
  newOidcHandshake,
  oidcCodeVerifierOptions,
  oidcPreAuthCookieSpec,
  oidcStateIsBound,
  safeReturnTo,
} from "../../src/index.ts";

describe("newOidcHandshake", () => {
  it("makes a state, a nonce and a PKCE verifier of 256 random bits each, as 43 base64url characters", () => {
    const handshake = newOidcHandshake();
    for (const value of [handshake.state, handshake.nonce, handshake.codeVerifier]) {
      expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(value, "base64url")).toHaveLength(32);
    }
    expect(new Set([handshake.state, handshake.nonce, handshake.codeVerifier]).size).toBe(3);
  });

  it("derives the S256 challenge of the verifier and the hash of the state, and draws new values every time", () => {
    const handshake = newOidcHandshake();
    expect(handshake.codeChallenge).toBe(createHash("sha256").update(handshake.codeVerifier).digest("base64url"));
    expect(handshake.stateHash).toEqual(createHash("sha256").update(handshake.state).digest());
    expect(newOidcHandshake().state).not.toBe(handshake.state);
  });
});

describe("hashOidcState", () => {
  it("hashes a state this server issues and nothing of another shape", () => {
    const { state, stateHash } = newOidcHandshake();
    expect(hashOidcState(state)).toEqual(stateHash);
    for (const value of ["", "short", `${state}x`, state.slice(1), `${state.slice(0, 42)}+`, `${state.slice(0, 42)}=`, " ".repeat(43)]) {
      expect(hashOidcState(value)).toBeUndefined();
    }
    // The last of 43 characters carries four bits that are not data, which are zero in what this server writes; "B" sets one.
    expect(hashOidcState(`${state.slice(0, 42)}B`)).toBeUndefined();
  });
});

describe("the binding of a state to a browser", () => {
  const key = Buffer.alloc(32, 1);

  it("accepts the value made for the state and no other", () => {
    const { state } = newOidcHandshake();
    const binding = bindOidcState(key, state);
    expect(oidcStateIsBound(key, state, binding)).toBe(true);
    expect(oidcStateIsBound(key, newOidcHandshake().state, binding)).toBe(false);
    expect(oidcStateIsBound(Buffer.alloc(32, 2), state, binding)).toBe(false);
    expect(oidcStateIsBound(key, state, "")).toBe(false);
    expect(oidcStateIsBound(key, state, state)).toBe(false);
    expect(oidcStateIsBound(key, state, binding.slice(1))).toBe(false);
  });

  it("does not reveal the state", () => {
    const { state } = newOidcHandshake();
    expect(bindOidcState(key, state)).not.toContain(state);
  });
});

describe("oidcCodeVerifierOptions", () => {
  it("binds a sealed verifier to the column and the record", () => {
    const first = oidcCodeVerifierOptions(Buffer.alloc(32, 1));
    const second = oidcCodeVerifierOptions(Buffer.alloc(32, 2));
    expect(new TextDecoder().decode(first.aad)).toBe(`oidc_login_states.code_verifier:${"01".repeat(32)}`);
    expect(second.aad).not.toEqual(first.aad);
  });
});

describe("oidcPreAuthCookieSpec", () => {
  it("is host-only with the __Host- prefix over https, and plain over http, living as long as a handshake", () => {
    expect(oidcPreAuthCookieSpec("https://slugbase.example")).toEqual({ name: "__Host-slugbase_oidc", secure: true, maxAgeSeconds: 600 });
    expect(oidcPreAuthCookieSpec("http://localhost:3000")).toEqual({ name: "slugbase_oidc", secure: false, maxAgeSeconds: 600 });
  });

  it("refuses an origin that is neither", () => {
    expect(() => oidcPreAuthCookieSpec("ftp://slugbase.example")).toThrow(RangeError);
  });
});

describe("safeReturnTo", () => {
  it("keeps a relative path with its query and fragment", () => {
    expect(safeReturnTo("/")).toBe("/");
    expect(safeReturnTo("/go/docs")).toBe("/go/docs");
    expect(safeReturnTo("/w/a?b=c&d=e#f")).toBe("/w/a?b=c&d=e#f");
    expect(safeReturnTo("/a/./b/../c")).toBe("/a/c");
  });

  it("falls back to the root for everything that could leave the origin (T12)", () => {
    const refused = [
      undefined,
      "",
      "go/docs",
      "https://evil.example/",
      "http://evil.example",
      "//evil.example",
      "///evil.example",
      "/\\evil.example",
      "\\\\evil.example",
      "/\\/evil.example",
      "/%2fevil.example",
      "/%2Fevil.example",
      "/%5cevil.example",
      "/a/%2e%2e/%2f/evil.example",
      "/.//evil.example",
      "/a/..//evil.example",
      "/..//evil.example",
      "/.%2e//evil.example",
      "javascript:alert(1)",
      "/\t/evil.example",
      "/\n/evil.example",
      "/ok\r\nSet-Cookie: x=y",
      "/\u0000",
      "/a".repeat(1100),
    ];
    for (const value of refused) {
      expect(safeReturnTo(value), String(value)).toBe("/");
    }
  });
});

describe("autoCreateAllowed", () => {
  it("allows any domain when the provider lists none, and only an exact listed domain otherwise, whatever case the address is in", () => {
    expect(autoCreateAllowed("ada@example.test", [])).toBe(true);
    expect(autoCreateAllowed("ada@example.test", ["example.test"])).toBe(true);
    expect(autoCreateAllowed("Ada@EXAMPLE.test", ["example.test"])).toBe(true);
    expect(autoCreateAllowed("ada@other.test", ["example.test"])).toBe(false);
    expect(autoCreateAllowed("ada@mail.example.test", ["example.test"])).toBe(false);
    expect(autoCreateAllowed("ada@example.test.evil.test", ["example.test"])).toBe(false);
    expect(autoCreateAllowed("ada@evil.test@example.test", ["example.test"])).toBe(false);
  });

  it("refuses an address that is not a plain local@domain, with or without a list", () => {
    for (const address of ["", "ada", "@example.test", "ada@", "a da@example.test", "ada@exa mple.test", "ada\u0000@example.test", `${"a".repeat(320)}@example.test`]) {
      expect(autoCreateAllowed(address, []), address).toBe(false);
    }
  });
});

describe("federatedDisplayName", () => {
  it("uses the name claim without control characters, cut at 100 characters, else the part of the address before the at sign", () => {
    expect(federatedDisplayName("  Ada Lovelace ", "ada@example.test")).toBe("Ada Lovelace");
    expect(federatedDisplayName("Ada\u0000\nLovelace", "ada@example.test")).toBe("AdaLovelace");
    expect(Array.from(federatedDisplayName("x".repeat(150), "ada@example.test"))).toHaveLength(100);
    expect(Array.from(federatedDisplayName("\u{1F600}".repeat(150), "ada@example.test"))).toHaveLength(100);
    expect(federatedDisplayName(undefined, "ada.l@example.test")).toBe("ada.l");
    expect(federatedDisplayName("  \u0000 ", "ada@example.test")).toBe("ada");
  });
});
