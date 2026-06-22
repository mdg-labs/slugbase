import { describe, expect, it } from "vitest";

import { resolveCorsOrigins } from "./resolve-cors-origins.js";

describe("resolveCorsOrigins", () => {
  it("includes FRONTEND_ORIGIN only when MARKETING_ORIGIN is unset", () => {
    expect(
      resolveCorsOrigins({
        FRONTEND_ORIGIN: "https://app.example.com",
        MARKETING_ORIGIN: undefined,
      }),
    ).toEqual(["https://app.example.com"]);
  });

  it("includes both origins when MARKETING_ORIGIN is set and distinct", () => {
    expect(
      resolveCorsOrigins({
        FRONTEND_ORIGIN: "https://app.example.com",
        MARKETING_ORIGIN: "https://www.example.com",
      }),
    ).toEqual(["https://app.example.com", "https://www.example.com"]);
  });

  it("deduplicates when MARKETING_ORIGIN matches FRONTEND_ORIGIN", () => {
    expect(
      resolveCorsOrigins({
        FRONTEND_ORIGIN: "https://app.example.com",
        MARKETING_ORIGIN: "https://app.example.com",
      }),
    ).toEqual(["https://app.example.com"]);
  });

  it("ignores blank MARKETING_ORIGIN", () => {
    expect(
      resolveCorsOrigins({
        FRONTEND_ORIGIN: "https://app.example.com",
        MARKETING_ORIGIN: "   ",
      }),
    ).toEqual(["https://app.example.com"]);
  });
});
