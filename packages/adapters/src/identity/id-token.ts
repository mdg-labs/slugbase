import { constants, createPublicKey, verify, type KeyObject } from "node:crypto";

// The validation of an ID token (OpenID Connect Core section 3.1.3.7, doc 10 T20). A claim is returned only
// after the signature has been verified with a key of the provider's own key set, and the issuer, the
// audience, the nonce and the times have been checked; any other outcome is a refusal with a fixed word and
// nothing of the token. The algorithm comes from a fixed list and has to fit the key that verifies it: `none`
// and the symmetric algorithms are never accepted, so a token cannot choose a weaker check.

/** Why a token was refused; the fixed words of the log line. */
export type IdTokenRefusal =
  | "malformed"
  | "algorithm"
  | "key"
  | "signature"
  | "issuer"
  | "audience"
  | "nonce"
  | "expired"
  | "not_yet_valid"
  | "subject";

export class IdTokenError extends Error {
  readonly refusal: IdTokenRefusal;

  constructor(refusal: IdTokenRefusal) {
    super(refusal);
    this.name = "IdTokenError";
    this.refusal = refusal;
  }
}

export interface IdTokenExpectation {
  /** The issuer exactly as the operator configured it. */
  readonly issuer: string;
  /** The client id the token must be issued to. */
  readonly clientId: string;
  /** The nonce the authorization request carried. */
  readonly nonce: string;
  /** The provider's key set. */
  readonly keys: readonly Readonly<Record<string, unknown>>[];
  /** The instant of the check, in milliseconds since the epoch. */
  readonly now: number;
}

/** What a verified token asserts. */
export interface VerifiedIdToken {
  readonly subject: string;
  readonly email: string | undefined;
  readonly emailVerified: boolean;
  readonly name: string | undefined;
}

/** How far the clocks of the provider and of this server may differ. */
const CLOCK_SKEW_SECONDS = 60;
const SUBJECT_MAX_LENGTH = 255;
const NAME_MAX_LENGTH = 100;

interface Algorithm {
  readonly keyType: "RSA" | "EC" | "OKP";
  /** For an elliptic curve, the curve of the key. */
  readonly curve?: string;
  readonly digest: string | null;
  readonly pss?: boolean;
}

const ALGORITHMS: Readonly<Record<string, Algorithm>> = {
  RS256: { keyType: "RSA", digest: "sha256" },
  RS384: { keyType: "RSA", digest: "sha384" },
  RS512: { keyType: "RSA", digest: "sha512" },
  PS256: { keyType: "RSA", digest: "sha256", pss: true },
  PS384: { keyType: "RSA", digest: "sha384", pss: true },
  PS512: { keyType: "RSA", digest: "sha512", pss: true },
  ES256: { keyType: "EC", curve: "P-256", digest: "sha256" },
  ES384: { keyType: "EC", curve: "P-384", digest: "sha384" },
  ES512: { keyType: "EC", curve: "P-521", digest: "sha512" },
  EdDSA: { keyType: "OKP", curve: "Ed25519", digest: null },
};

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeSegment(segment: string): Buffer {
  const bytes = Buffer.from(segment, "base64url");
  if (segment === "" || bytes.toString("base64url") !== segment) {
    throw new IdTokenError("malformed");
  }
  return bytes;
}

function decodeObject(segment: string): Readonly<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decodeSegment(segment)));
    if (isRecord(parsed)) {
      return parsed;
    }
  } catch (error) {
    if (error instanceof IdTokenError) {
      throw error;
    }
  }
  throw new IdTokenError("malformed");
}

// The keys that may have signed a token with this header: the key named by `kid` (every key when the token
// names none), meant for signatures, and of the type, curve and algorithm the header's algorithm needs.
function candidateKeys(
  keys: IdTokenExpectation["keys"],
  header: Readonly<Record<string, unknown>>,
  name: string,
  algorithm: Algorithm,
): KeyObject[] {
  const kid = header["kid"];
  const matching = keys.filter(
    (key) =>
      (kid === undefined || key["kid"] === kid) &&
      (key["use"] === undefined || key["use"] === "sig") &&
      (key["alg"] === undefined || key["alg"] === name) &&
      key["kty"] === algorithm.keyType &&
      (algorithm.curve === undefined || key["crv"] === algorithm.curve),
  );
  const objects: KeyObject[] = [];
  for (const key of matching) {
    try {
      objects.push(createPublicKey({ key, format: "jwk" }));
    } catch {
      // A key the runtime cannot read is not a candidate; the others still are.
    }
  }
  return objects;
}

function signatureHolds(input: string, signature: Buffer, key: KeyObject, algorithm: Algorithm): boolean {
  const data = Buffer.from(input, "ascii");
  try {
    if (algorithm.keyType === "EC") {
      return verify(algorithm.digest, data, { key, dsaEncoding: "ieee-p1363" }, signature);
    }
    if (algorithm.pss === true) {
      return verify(algorithm.digest, data, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }, signature);
    }
    return verify(algorithm.digest, data, key, signature);
  } catch {
    return false;
  }
}

function audienceHolds(aud: unknown, azp: unknown, clientId: string): boolean {
  if (typeof aud === "string") {
    return aud === clientId && (azp === undefined || azp === clientId);
  }
  // With several audiences the token has to say which party it was issued to.
  return Array.isArray(aud) && aud.includes(clientId) && (aud.length === 1 ? azp === undefined || azp === clientId : azp === clientId);
}

function seconds(claim: unknown): number | undefined {
  return typeof claim === "number" && Number.isFinite(claim) ? claim : undefined;
}

/**
 * Verifies the compact serialisation of an ID token and returns the claims the sign-in uses. Throws an
 * `IdTokenError` for a token that is malformed, signed with an algorithm or key it may not be, not signed by a
 * key of the provider, from another issuer, for another client, for another request (nonce), expired or not
 * yet valid, or without a subject.
 */
export function verifyIdToken(token: string, expected: IdTokenExpectation): VerifiedIdToken {
  const parts = token.split(".");
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  if (parts.length !== 3 || encodedHeader === undefined || encodedPayload === undefined || encodedSignature === undefined) {
    throw new IdTokenError("malformed");
  }
  const header = decodeObject(encodedHeader);
  const claims = decodeObject(encodedPayload);

  // A header that lists critical extensions asks the recipient to understand them or refuse the token; none is understood.
  if (header["crit"] !== undefined) {
    throw new IdTokenError("malformed");
  }

  const name = header["alg"];
  const algorithm = typeof name === "string" && Object.hasOwn(ALGORITHMS, name) ? ALGORITHMS[name] : undefined;
  if (typeof name !== "string" || algorithm === undefined) {
    throw new IdTokenError("algorithm");
  }
  const signature = decodeSegment(encodedSignature);
  const candidates = candidateKeys(expected.keys, header, name, algorithm);
  if (candidates.length === 0) {
    throw new IdTokenError("key");
  }
  if (!candidates.some((key) => signatureHolds(`${encodedHeader}.${encodedPayload}`, signature, key, algorithm))) {
    throw new IdTokenError("signature");
  }

  if (claims["iss"] !== expected.issuer) {
    throw new IdTokenError("issuer");
  }
  if (!audienceHolds(claims["aud"], claims["azp"], expected.clientId)) {
    throw new IdTokenError("audience");
  }
  if (typeof claims["nonce"] !== "string" || claims["nonce"] !== expected.nonce) {
    throw new IdTokenError("nonce");
  }
  const nowSeconds = expected.now / 1000;
  const exp = seconds(claims["exp"]);
  if (exp === undefined || exp <= nowSeconds - CLOCK_SKEW_SECONDS) {
    throw new IdTokenError("expired");
  }
  const iat = seconds(claims["iat"]);
  const nbf = seconds(claims["nbf"]);
  if ((claims["iat"] !== undefined && iat === undefined) || (claims["nbf"] !== undefined && nbf === undefined)) {
    throw new IdTokenError("malformed");
  }
  if ((iat !== undefined && iat > nowSeconds + CLOCK_SKEW_SECONDS) || (nbf !== undefined && nbf > nowSeconds + CLOCK_SKEW_SECONDS)) {
    throw new IdTokenError("not_yet_valid");
  }
  const subject = claims["sub"];
  if (typeof subject !== "string" || subject === "" || subject.length > SUBJECT_MAX_LENGTH) {
    throw new IdTokenError("subject");
  }

  const email = claims["email"];
  const verified = claims["email_verified"];
  const displayName = claims["name"];
  return {
    subject,
    email: typeof email === "string" && email !== "" ? email : undefined,
    // Some providers write the flag as the string "true".
    emailVerified: typeof email === "string" && email !== "" && (verified === true || verified === "true"),
    name: typeof displayName === "string" && displayName.trim() !== "" ? Array.from(displayName.trim()).slice(0, NAME_MAX_LENGTH).join("") : undefined,
  };
}
