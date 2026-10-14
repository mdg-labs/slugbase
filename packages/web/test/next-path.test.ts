import { describe, expect, it } from "vitest";
import { safeNextPath } from "../src/auth/next-path.ts";

describe("safeNextPath", () => {
  it.each([
    ["/", "/"],
    ["/bookmarks", "/bookmarks"],
    ["/bookmarks?tag=a&view=table#top", "/bookmarks?tag=a&view=table#top"],
    ["/missing/page?tab=plan#top", "/missing/page?tab=plan#top"],
  ])("keeps the same-origin path %s", (value, expected) => {
    expect(safeNextPath(value)).toBe(expected);
  });

  it.each([
    "https://evil.example/phish",
    "http://evil.example",
    "//evil.example",
    "//evil.example/phish",
    "/\\evil.example",
    "/\t/evil.example",
    "/\n/evil.example",
    "\\\\evil.example",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "bookmarks",
    "",
    " /bookmarks",
  ])("ignores %j", (value) => {
    expect(safeNextPath(value)).toBe("/");
  });

  it.each([undefined, null, 42, true, ["/a"], { path: "/a" }])("ignores %j, which is not a string", (value) => {
    expect(safeNextPath(value)).toBe("/");
  });
});
