import { describe, expect, it } from "vitest";
import { cleanText, cutCodePoints, plainText } from "../../src/index.ts";

// The text of an import file (doc 02 section 13.1, doc 10 T13): control characters out, lone surrogates replaced, ends trimmed, cut by code points.

describe("plainText", () => {
  it("removes every control character: C0, DEL and C1, the line breaks and the tab among them", () => {
    const controls = Array.from({ length: 0x20 }, (_, code) => String.fromCharCode(code)).join("") + "\u007f" + Array.from({ length: 0x20 }, (_, index) => String.fromCharCode(0x80 + index)).join("");
    expect(plainText(`a${controls}b`)).toBe("ab");
    expect(plainText("line one\nline two\tend")).toBe("line oneline twoend");
  });

  it("trims the ends, keeps the inside spaces, and leaves markup the characters it is", () => {
    expect(plainText("  <b>Hello</b>  world  ")).toBe("<b>Hello</b>  world");
    expect(plainText('<script>alert("x")</script>')).toBe('<script>alert("x")</script>');
  });

  it("replaces a lone surrogate, which no encoding of a stored value can carry, and keeps a pair", () => {
    expect(plainText("a\ud800b")).toBe("a�b");
    expect(plainText("😀")).toBe("😀");
  });
});

describe("cutCodePoints", () => {
  it("cuts by code points and never inside a surrogate pair", () => {
    expect(cutCodePoints("😀😀😀", 2)).toBe("😀😀");
    expect(cutCodePoints("abc", 3)).toBe("abc");
    expect(cutCodePoints("abcd", 3)).toBe("abc");
    expect(cutCodePoints("😀😀", 2)).toBe("😀😀");
  });

  it("trims the space a cut leaves at the end", () => {
    expect(cutCodePoints("ab  cd", 3)).toBe("ab");
  });

  it("stops scanning at the cut, so a huge string costs no more than the limit", () => {
    const huge = "x".repeat(5 * 1024 * 1024);
    const start = performance.now();
    expect(cutCodePoints(huge, 300)).toHaveLength(300);
    expect(performance.now() - start).toBeLessThan(500);
  });
});

describe("cleanText", () => {
  it("is plain text cut to the limit", () => {
    expect(cleanText("  \u0000" + "é".repeat(400), 300)).toBe("é".repeat(300));
    expect(cleanText("\u0000\u0007 \n", 300)).toBe("");
  });
});
