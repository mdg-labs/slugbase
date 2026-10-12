import { describe, expect, it } from "vitest";
import { envBoolean } from "../../src/config/index.ts";

describe("envBoolean", () => {
  it.each([
    ["true", true],
    ["1", true],
    ["false", false],
    ["0", false],
  ])("parses %j as %s", (input, expected) => {
    expect(envBoolean().parse(input)).toBe(expected);
  });

  it.each(["", "yes", "no", "True", "FALSE", " true", "2", "on", "off"])("rejects %j", (input) => {
    expect(envBoolean().safeParse(input).success).toBe(false);
  });

  it("takes its default only when the key is unset", () => {
    expect(envBoolean().default(true).parse(undefined)).toBe(true);
    expect(envBoolean().default(false).parse(undefined)).toBe(false);
    expect(envBoolean().default(true).parse("false")).toBe(false);
    expect(envBoolean().default(true).safeParse("").success).toBe(false);
  });
});
