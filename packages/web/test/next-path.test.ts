import { describe, expect, it } from "vitest";
import { safeNextPath } from "../src/auth/next-path.ts";
import { currentReturnTo, oidcInvitationStartPath, oidcStartPath } from "../src/auth/oidc.ts";

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

describe("oidcInvitationStartPath", () => {
  it("carries the token in the invitation parameter, encoded, with the invite intent and no page to come back to", () => {
    const path = oidcInvitationStartPath("acme-sso", "abc_DEF-123");
    expect(path).toBe("/api/v1/auth/oidc/acme-sso/start?intent=invite&invitation=abc_DEF-123");
    const url = new URL(path, "http://x.invalid");
    expect(url.searchParams.get("returnTo")).toBeNull();
    expect(url.searchParams.get("invitation")).toBe("abc_DEF-123");
  });

  it("encodes a provider slug and a token that are not plain text, so they cannot add a parameter", () => {
    const path = oidcInvitationStartPath("a/b", "x&intent=login");
    const url = new URL(path, "http://x.invalid");
    expect(url.pathname).toBe("/api/v1/auth/oidc/a%2Fb/start");
    expect(url.searchParams.getAll("intent")).toEqual(["invite"]);
    expect(url.searchParams.get("invitation")).toBe("x&intent=login");
  });
});

describe("oidcStartPath", () => {
  it("keeps an ordinary page as the page to come back to", () => {
    expect(oidcStartPath("acme", "reauth", "/settings/account/security?tab=a")).toBe(
      "/api/v1/auth/oidc/acme/start?intent=reauth&returnTo=%2Fsettings%2Faccount%2Fsecurity%3Ftab%3Da",
    );
  });

  it.each(["/invite/abc123tokenvalue", "/invite/abc123tokenvalue?x=1", "/INVITE/abc123tokenvalue", "/x/../invite/abc123tokenvalue"])(
    "never puts the invitation link %s into the start address",
    (returnTo) => {
      for (const intent of ["login", "link", "reauth"] as const) {
        const path = oidcStartPath("acme", intent, returnTo);
        expect(path).not.toContain("abc123tokenvalue");
        expect(new URL(path, "http://x.invalid").searchParams.get("returnTo")).toBe("/");
      }
    },
  );

  it("does not take the page the member is on along when that is an invitation link", () => {
    window.history.replaceState(null, "", "/invite/abc123tokenvalue");
    expect(currentReturnTo()).toBe("/");
  });
});
