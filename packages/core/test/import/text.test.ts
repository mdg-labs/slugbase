import { describe, expect, it } from "vitest";
import { cleanDescription, cleanText, cutCodePoints, plainDescription, plainText } from "../../src/index.ts";

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

describe("plainDescription", () => {
  it("keeps a line break and a tab, and turns \\r\\n and a lone \\r into \\n", () => {
    expect(plainDescription("a\nb\tc")).toBe("a\nb\tc");
    expect(plainDescription("a\r\nb\rc\n\rd")).toBe("a\nb\nc\n\nd");
  });

  it("removes every other control character: C0, DEL and C1, NUL and the vertical tab, form feed, NEL and bell among them", () => {
    const others = [...Array.from({ length: 0x20 }, (_, code) => code), 0x7f, ...Array.from({ length: 0x20 }, (_, index) => 0x80 + index)].filter((code) => ![0x09, 0x0a, 0x0d].includes(code));
    expect(plainDescription(`a${others.map((code) => String.fromCharCode(code)).join("")}b`)).toBe("ab");
    expect(plainDescription("a\u0007b\u0085c\u0000d\u000be\u000cf")).toBe("abcdef");
    expect(plainDescription("a\u0000\nb")).toBe("a\nb");
  });

  it("trims the ends, line breaks and tabs included, and keeps the inside", () => {
    expect(plainDescription("\n\t first\n\n  second \t\n")).toBe("first\n\n  second");
  });

  it("replaces a lone surrogate and keeps a pair", () => {
    expect(plainDescription("a\ud800\nb 😀")).toBe("a�\nb 😀");
  });
});

describe("cleanDescription", () => {
  it("cleans the description, then cuts it by code points, counting a kept line break as one", () => {
    expect(cleanDescription("a\r\nb\u0007c", 300)).toBe("a\nbc");
    expect(cleanDescription("ab\r\ncd", 3)).toBe("ab");
    expect(cleanDescription("a\r\n😀😀", 4)).toBe("a\n😀😀");
    expect(cleanDescription("\u0000\u0007 \n\t", 300)).toBe("");
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
