import { sessionCookieSpec } from "@slugbase/core";
import { describe, expect, it } from "vitest";
import { clearSessionCookie, readCookie, setSessionCookie } from "../../src/auth/cookie.ts";

describe("setSessionCookie", () => {
  it("is __Host- prefixed, host-only, HttpOnly, Secure and SameSite=Lax over https", () => {
    const header = setSessionCookie(sessionCookieSpec("https://bookmarks.example.com"), "tok");
    expect(header).toBe("__Host-slugbase_session=tok; Max-Age=15552000; Path=/; HttpOnly; SameSite=Lax; Secure");
    expect(header).not.toMatch(/Domain/i);
  });

  it("is the plain name without Secure over http, whatever the host", () => {
    for (const origin of ["http://localhost:5173", "http://bookmarks.example.com"]) {
      const header = setSessionCookie(sessionCookieSpec(origin), "tok");
      expect(header).toBe("slugbase_session=tok; Max-Age=15552000; Path=/; HttpOnly; SameSite=Lax");
      expect(header).not.toMatch(/Secure|Domain|__Host-/);
    }
  });
});

describe("clearSessionCookie", () => {
  it("expires the same cookie with the same scope", () => {
    expect(clearSessionCookie(sessionCookieSpec("https://bookmarks.example.com"))).toBe(
      "__Host-slugbase_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax; Secure; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    );
    expect(clearSessionCookie(sessionCookieSpec("http://localhost:5173"))).toBe(
      "slugbase_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    );
  });
});

describe("readCookie", () => {
  it("finds the named cookie among others", () => {
    expect(readCookie("a=1; __Host-slugbase_session=tok; b=2", "__Host-slugbase_session")).toBe("tok");
    expect(readCookie("__Host-slugbase_session=tok", "__Host-slugbase_session")).toBe("tok");
    expect(readCookie("  slugbase_session = tok ", "slugbase_session")).toBe("tok");
  });

  it("does not take a cookie whose name only ends or starts with the wanted one", () => {
    expect(readCookie("x__Host-slugbase_session=evil", "__Host-slugbase_session")).toBeUndefined();
    expect(readCookie("__Host-slugbase_session2=evil", "__Host-slugbase_session")).toBeUndefined();
    expect(readCookie("slugbase_session=tok", "__Host-slugbase_session")).toBeUndefined();
  });

  it("answers undefined when it is absent or the header is empty", () => {
    expect(readCookie("", "slugbase_session")).toBeUndefined();
    expect(readCookie("a=1", "slugbase_session")).toBeUndefined();
    expect(readCookie("=tok", "slugbase_session")).toBeUndefined();
  });

  it("takes the first when the name is repeated", () => {
    expect(readCookie("slugbase_session=first; slugbase_session=second", "slugbase_session")).toBe("first");
  });
});
