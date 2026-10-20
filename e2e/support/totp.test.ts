import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { base32Decode, totpCode, totpStep } from "./totp.ts";

// RFC 6238 appendix B: the SHA-1 secret is the ASCII string 12345678901234567890; its 8-digit codes
// end in the 6 digits that the server and the apps show.
const RFC_6238_KEY = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

void describe("the authenticator of the journeys", () => {
  void it("decodes a base32 key, spaces and padding aside", () => {
    assert.equal(base32Decode(RFC_6238_KEY).toString("ascii"), "12345678901234567890");
    assert.equal(base32Decode("gezd gnbv gy3t qojq gezd gnbv gy3t qojq====").toString("ascii"), "12345678901234567890");
    assert.equal(base32Decode("MZXW6YTBOI======").toString("ascii"), "foobar");
  });

  void it("refuses text that is not base32", () => {
    assert.throws(() => base32Decode("not base32!"), /base32/);
  });

  void it("derives the codes of RFC 6238 appendix B", () => {
    const vectors: readonly (readonly [number, string])[] = [
      [59, "287082"],
      [1111111109, "081804"],
      [1111111111, "050471"],
      [1234567890, "005924"],
      [2000000000, "279037"],
    ];
    for (const [seconds, code] of vectors) {
      assert.equal(totpCode(RFC_6238_KEY, totpStep(seconds * 1000)), code, `at ${String(seconds)} seconds`);
    }
  });

  void it("changes the code with the step and not within one", () => {
    assert.equal(totpStep(59_999), 1);
    assert.equal(totpStep(60_000), 2);
    assert.notEqual(totpCode(RFC_6238_KEY, 1), totpCode(RFC_6238_KEY, 2));
  });
});
