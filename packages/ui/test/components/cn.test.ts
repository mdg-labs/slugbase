import { describe, expect, it } from "vitest";
import { cn } from "../../src/index.ts";

describe("cn", () => {
  it("joins class names and drops falsy ones", () => {
    expect(cn("px-2", false, undefined, "py-1")).toBe("px-2 py-1");
  });

  it("lets the later Tailwind utility win over a conflicting earlier one", () => {
    expect(cn("px-2 text-sm", "px-4")).toBe("text-sm px-4");
  });
});
