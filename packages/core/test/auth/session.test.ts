import { describe, expect, it } from "vitest";
import { SESSION_ABSOLUTE_DAYS, USER_AGENT_MAX_LENGTH, sessionCookieSpec, truncateUserAgent } from "../../src/index.ts";

describe("sessionCookieSpec", () => {
  it("names the __Host- cookie and flags it Secure when the origin is https", () => {
    expect(sessionCookieSpec("https://links.example.test")).toEqual({
      name: "__Host-slugbase_session",
      secure: true,
      maxAgeSeconds: SESSION_ABSOLUTE_DAYS * 86_400,
    });
  });

  it("names the plain cookie without Secure when the origin is http, whatever the host", () => {
    for (const origin of ["http://localhost:5173", "http://links.example.test"]) {
      expect(sessionCookieSpec(origin)).toMatchObject({ name: "slugbase_session", secure: false });
    }
  });

  it("refuses an origin that is neither", () => {
    expect(() => sessionCookieSpec("ftp://links.example.test")).toThrow(RangeError);
    expect(() => sessionCookieSpec("links.example.test")).toThrow();
  });
});

describe("truncateUserAgent", () => {
  it("passes a short user agent through and reports an absent one as null", () => {
    expect(truncateUserAgent("Mozilla/5.0")).toBe("Mozilla/5.0");
    expect(truncateUserAgent(undefined)).toBeNull();
    expect(truncateUserAgent(null)).toBeNull();
    expect(truncateUserAgent("")).toBeNull();
  });

  it("cuts a long one to 256 characters", () => {
    expect(truncateUserAgent("a".repeat(1000))).toBe("a".repeat(USER_AGENT_MAX_LENGTH));
    expect(truncateUserAgent("a".repeat(USER_AGENT_MAX_LENGTH))).toBe("a".repeat(USER_AGENT_MAX_LENGTH));
  });

  it("never splits a character that takes two UTF-16 units", () => {
    const cut = truncateUserAgent("😀".repeat(300)) ?? "";
    expect(Array.from(cut)).toHaveLength(USER_AGENT_MAX_LENGTH);
    expect(cut).toBe("😀".repeat(USER_AGENT_MAX_LENGTH));
    expect(cut.isWellFormed()).toBe(true);
  });
});
