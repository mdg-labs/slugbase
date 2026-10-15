import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { SecretBoxOptions } from "../ports/secret-box.ts";

// The parts of the OIDC authorization-code handshake that belong to the domain (doc 02 section 2.8, doc 04
// section 4.5, doc 10 T4, T12 and T20): the one-time values a handshake is made of, the check that a
// `returnTo` stays on this origin, and the binding of a handshake to the browser that started it. The
// functions are pure apart from the random draws; nothing here logs or keeps a value.

/** How long a handshake may take from its start to its callback. */
export const OIDC_HANDSHAKE_SECONDS = 600;

/** The code every failed OIDC sign-in ends with, whatever the reason: `/login?error=<code>`. */
export const OIDC_FAILURE_CODE = "oidc_failed";

const VALUE_BYTES = 32;
const ENCODED_LENGTH = Math.ceil((VALUE_BYTES * 4) / 3);
const RETURN_TO_MAX_LENGTH = 2048;

/** What a handshake that is starting is made of. */
export interface OidcHandshake {
  /** Sent to the provider, which echoes it to the callback. */
  readonly state: string;
  /** SHA-256 of `state`, what the database keys the record by. */
  readonly stateHash: Buffer;
  /** Sent to the provider, which puts it in the ID token. */
  readonly nonce: string;
  /** The PKCE verifier (RFC 7636): kept server side and sent only to the token endpoint. */
  readonly codeVerifier: string;
  /** The S256 challenge of `codeVerifier`, sent to the provider with the authorization request. */
  readonly codeChallenge: string;
}

function random(): string {
  return randomBytes(VALUE_BYTES).toString("base64url");
}

function sha256(value: string | Buffer): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Fresh values from the operating system's random source: 256 bits each, 43 base64url characters. */
export function newOidcHandshake(): OidcHandshake {
  const state = random();
  const codeVerifier = random();
  return {
    state,
    stateHash: sha256(state),
    nonce: random(),
    codeVerifier,
    codeChallenge: sha256(codeVerifier).toString("base64url"),
  };
}

/** True for exactly the text `newOidcHandshake` writes for a state: 43 base64url characters. */
function isEncodedValue(value: string): boolean {
  return value.length === ENCODED_LENGTH && /^[A-Za-z0-9_-]+$/.test(value) && Buffer.from(value, "base64url").toString("base64url") === value;
}

/** The hash a state is looked up by, or undefined for a value that is not a state this server could have issued. */
export function hashOidcState(state: string): Buffer | undefined {
  return isEncodedValue(state) ? sha256(state) : undefined;
}

/**
 * What binds a sealed code verifier to where it is stored (the column and the record), so a ciphertext copied
 * to another record does not open there.
 */
export function oidcCodeVerifierOptions(stateHash: Buffer): SecretBoxOptions {
  return { aad: new TextEncoder().encode(`oidc_login_states.code_verifier:${stateHash.toString("hex")}`) };
}

/**
 * The value of the pre-auth cookie of a handshake: a keyed hash of its state. The callback accepts a state
 * only together with this value, so a handshake completes only in the browser that started it; the cookie
 * does not reveal the state, and a state seen in an address or a log is no use without the cookie.
 */
export function bindOidcState(key: Uint8Array, state: string): string {
  return createHmac("sha256", key).update(state).digest("base64url");
}

/** Whether `binding` is the value `bindOidcState` makes for `state`, compared in constant time. */
export function oidcStateIsBound(key: Uint8Array, state: string, binding: string): boolean {
  const given = Buffer.from(binding, "base64url");
  const expected = Buffer.from(bindOidcState(key, state), "base64url");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** How the pre-auth cookie is named and flagged for a deployment. */
export interface OidcPreAuthCookieSpec {
  readonly name: string;
  /** `__Host-slugbase_oidc` needs `Secure`; the plain name is used where the browser would refuse the prefix. */
  readonly secure: boolean;
  readonly maxAgeSeconds: number;
}

/** The pre-auth cookie for the deployment origin: `__Host-` and `Secure` when `APP_ORIGIN` is https, like the session cookie. */
export function oidcPreAuthCookieSpec(appOrigin: string): OidcPreAuthCookieSpec {
  if (appOrigin.startsWith("https://")) {
    return { name: "__Host-slugbase_oidc", secure: true, maxAgeSeconds: OIDC_HANDSHAKE_SECONDS };
  }
  if (appOrigin.startsWith("http://")) {
    return { name: "slugbase_oidc", secure: false, maxAgeSeconds: OIDC_HANDSHAKE_SECONDS };
  }
  throw new RangeError("the application origin must be http or https");
}

/**
 * The `returnTo` of a sign-in as a same-origin relative path, or `/` for anything else (T12). A path is
 * accepted when it starts with a single slash, holds no backslash, control character or percent-encoded
 * slash or backslash, and resolves against the origin to a path of that origin that does not itself start
 * with two slashes: an absolute URL, a protocol-relative one (`//host`) and a path a browser would read as
 * either are all refused. The path returned is the resolved one, without dot segments.
 */
export function safeReturnTo(value: string | undefined): string {
  const fallback = "/";
  if (value === undefined || value === "" || value.length > RETURN_TO_MAX_LENGTH || !value.startsWith("/") || value.startsWith("//")) {
    return fallback;
  }
  if (/[\\\u0000-\u001f\u007f]/.test(value) || /%(?:2f|5c)/i.test(value)) {
    return fallback;
  }
  const base = "https://origin.invalid";
  const resolved = URL.canParse(value, base) ? new URL(value, base) : undefined;
  if (resolved === undefined || resolved.origin !== base || resolved.username !== "" || resolved.password !== "") {
    return fallback;
  }
  // Removing the dot segments can leave a path that starts with two slashes (`/.//host` becomes `//host`), which a
  // browser reads as an address on another host.
  const path = `${resolved.pathname}${resolved.search}${resolved.hash}`;
  return path.startsWith("//") ? fallback : path;
}
