import { describe, expect, it } from "vitest";
import {
  BACKUP_CODE_ALPHABET,
  TOTP_PERIOD_SECONDS,
  base32Encode,
  generateBackupCodes,
  generateTotpSecret,
  otpauthUri,
  totpCode,
  totpStep,
  verifyTotp,
} from "../../src/auth/mfa.ts";

// RFC 6238 appendix B: the SHA-1 secret "12345678901234567890" and the 8-digit codes of its table; a 6-digit code is the
// last six digits of the same truncated value.
const RFC_SECRET = new TextEncoder().encode("12345678901234567890");
const RFC_VECTORS: readonly [seconds: number, code: string][] = [
  [59, "287082"],
  [1111111109, "081804"],
  [1111111111, "050471"],
  [1234567890, "005924"],
  [2000000000, "279037"],
  [20000000000, "353130"],
];

describe("totpCode", () => {
  it.each(RFC_VECTORS)("matches the RFC 6238 vector at %d seconds", (seconds, code) => {
    expect(totpCode(RFC_SECRET, totpStep(seconds * 1000))).toBe(code);
  });

  it("keeps the leading zeros of a code", () => {
    expect(totpCode(RFC_SECRET, totpStep(1234567890 * 1000))).toHaveLength(6);
  });
});

describe("totpStep", () => {
  it("is the number of whole 30-second periods since the epoch", () => {
    expect(TOTP_PERIOD_SECONDS).toBe(30);
    expect(totpStep(0)).toBe(0);
    expect(totpStep(29_999)).toBe(0);
    expect(totpStep(30_000)).toBe(1);
    expect(totpStep(59_000)).toBe(1);
  });
});

describe("verifyTotp", () => {
  const now = 1111111111 * 1000;
  const step = totpStep(now);

  it("returns the step of a code of the current step", () => {
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step), now)).toBe(step);
  });

  it("accepts one step of skew either side and returns the step the code is from", () => {
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 1), now)).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 1), now)).toBe(step + 1);
  });

  it("refuses a code two steps away", () => {
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 2), now)).toBeUndefined();
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 2), now)).toBeUndefined();
  });

  it("accepts the edges of the window by the second: a code of the previous step until 30 seconds into the next", () => {
    const previous = totpCode(RFC_SECRET, step - 1);
    expect(verifyTotp(RFC_SECRET, previous, (step * 30 + 29) * 1000)).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, previous, ((step + 1) * 30 + 29) * 1000)).toBeUndefined();
  });

  it("refuses a code of another secret", () => {
    const other = new TextEncoder().encode("another secret of 20");
    expect(verifyTotp(RFC_SECRET, totpCode(other, step), now)).toBeUndefined();
  });

  it("ignores spaces and refuses anything that is not six digits", () => {
    const code = totpCode(RFC_SECRET, step);
    expect(verifyTotp(RFC_SECRET, `${code.slice(0, 3)} ${code.slice(3)}`, now)).toBe(step);
    for (const typed of ["", "12345", `${code}0`, "abcdef", `${code}\n`, "٠٠٠٠٠٠"]) {
      expect(verifyTotp(RFC_SECRET, typed, now), typed).toBeUndefined();
    }
  });

  it("never takes a step below 1 as a candidate", () => {
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, 0), 0)).toBeUndefined();
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, 1), 0)).toBe(1);
  });
});

describe("generateTotpSecret", () => {
  it("is 20 random bytes", () => {
    const first = generateTotpSecret();
    expect(first).toHaveLength(20);
    expect(Buffer.from(first).equals(Buffer.from(generateTotpSecret()))).toBe(false);
  });
});

describe("base32Encode", () => {
  it.each([
    ["", ""],
    ["f", "MY"],
    ["fo", "MZXQ"],
    ["foo", "MZXW6"],
    ["foob", "MZXW6YQ"],
    ["fooba", "MZXW6YTB"],
    ["foobar", "MZXW6YTBOI"],
  ])("encodes %j as the RFC 4648 text %s without padding", (plain, encoded) => {
    expect(base32Encode(new TextEncoder().encode(plain))).toBe(encoded);
  });

  it("encodes the 20 bytes of a secret as 32 characters", () => {
    expect(base32Encode(RFC_SECRET)).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  });
});

describe("otpauthUri", () => {
  it("names the issuer twice, the account in the label and the parameters of the code", () => {
    const uri = new URL(otpauthUri({ issuer: "SlugBase (links.example.com)", account: "ada@example.com", secret: "GEZDGNBV" }));
    expect(uri.protocol).toBe("otpauth:");
    expect(uri.host).toBe("totp");
    expect(decodeURIComponent(uri.pathname)).toBe("/SlugBase (links.example.com):ada@example.com");
    expect(Object.fromEntries(uri.searchParams)).toEqual({
      secret: "GEZDGNBV",
      issuer: "SlugBase (links.example.com)",
      algorithm: "SHA1",
      digits: "6",
      period: "30",
    });
  });

  it("encodes characters of the issuer and the account that would end the label or the query", () => {
    const text = otpauthUri({ issuer: "A&B", account: "a+b@example.com?x=y#z", secret: "GEZDGNBV" });
    expect(text).not.toMatch(/[#]/);
    expect(text.split("?")).toHaveLength(2);
    const uri = new URL(text);
    expect(uri.searchParams.get("issuer")).toBe("A&B");
    expect(decodeURIComponent(uri.pathname)).toBe("/A&B:a+b@example.com?x=y#z");
  });
});

describe("generateBackupCodes", () => {
  it("makes ten distinct codes of ten characters from the alphabet without look-alikes", () => {
    const codes = generateBackupCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) {
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{10}$/);
    }
    expect(BACKUP_CODE_ALPHABET).toHaveLength(32);
    expect(new Set(BACKUP_CODE_ALPHABET).size).toBe(32);
  });

  it("makes new codes each time", () => {
    expect(generateBackupCodes()).not.toEqual(generateBackupCodes());
  });
});
