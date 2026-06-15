import { describe, expect, it } from "vitest";

import { ChooseSlugBodySchema } from "./slugs.contract.js";

describe("ChooseSlugBodySchema", () => {
  it("accepts bookmarkId with optional remember", () => {
    expect(
      ChooseSlugBodySchema.safeParse({
        bookmarkId: "bm-1",
        remember: true,
      }).success,
    ).toBe(true);
  });

  it("accepts bookmarkId without remember", () => {
    expect(
      ChooseSlugBodySchema.safeParse({ bookmarkId: "bm-1" }).success,
    ).toBe(true);
  });

  it("rejects unknown fields", () => {
    expect(
      ChooseSlugBodySchema.safeParse({
        bookmarkId: "bm-1",
        extra: true,
      }).success,
    ).toBe(false);
  });

  it("rejects missing bookmarkId", () => {
    expect(ChooseSlugBodySchema.safeParse({ remember: true }).success).toBe(
      false,
    );
  });
});
