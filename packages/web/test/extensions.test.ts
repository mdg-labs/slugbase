import { describe, expect, it } from "vitest";
import { assertValidExtensions } from "../src/extensions.ts";

describe("assertValidExtensions", () => {
  it("accepts no extensions and distinct ids", () => {
    expect(() => {
      assertValidExtensions([]);
    }).not.toThrow();
    expect(() => {
      assertValidExtensions([{ id: "billing" }, { id: "analytics" }]);
    }).not.toThrow();
  });

  it("rejects a duplicate id and names it", () => {
    expect(() => {
      assertValidExtensions([{ id: "billing" }, { id: "billing" }]);
    }).toThrow(/"billing" is used twice/);
  });

  it("rejects an empty id", () => {
    expect(() => {
      assertValidExtensions([{ id: " " }]);
    }).toThrow(/non-empty id/);
  });
});
