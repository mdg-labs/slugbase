import { describe, expect, it } from "vitest";
import { resolveTheme } from "./resolve-theme.js";

describe("resolveTheme", () => {
  it("returns dark when preference is dark regardless of system", () => {
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("returns light when preference is light regardless of system", () => {
    expect(resolveTheme("light", true)).toBe("light");
  });

  it("follows system preference when auto", () => {
    expect(resolveTheme("auto", true)).toBe("dark");
    expect(resolveTheme("auto", false)).toBe("light");
  });
});
