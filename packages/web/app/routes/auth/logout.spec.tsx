import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { action, loader } from "./logout.js";

describe("Logout route - loader", () => {
  beforeEach(() => {
    process.env["API_BASE_URL"] = "http://localhost:3000";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env["API_BASE_URL"];
  });

  it("revokes the server session before clearing the cookie", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const request = new Request("http://localhost/logout");
    vi.spyOn(request.headers, "get").mockImplementation((name) =>
      name.toLowerCase() === "cookie" ? "slb_session=session-token-123" : null,
    );
    const args = { request, params: {}, context: {} } as unknown as LoaderFunctionArgs;

    const result = await loader(args);

    expect(fetchMock).toHaveBeenCalledWith("http://localhost:3000/auth/logout", {
      method: "POST",
      headers: { Cookie: "slb_session=session-token-123" },
    });

    expect(result).toBeInstanceOf(Response);
    expect(result.status).toBe(302);
    expect(result.headers.get("Location")).toBe("/login");
    expect(result.headers.get("Set-Cookie")).toContain("slb_session=");
    expect(result.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });

  it("still clears the cookie when the backend revoke call fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));

    const request = new Request("http://localhost/logout");
    vi.spyOn(request.headers, "get").mockImplementation((name) =>
      name.toLowerCase() === "cookie" ? "slb_session=session-token-123" : null,
    );
    const args = { request, params: {}, context: {} } as unknown as LoaderFunctionArgs;

    const result = await loader(args);

    expect(result).toBeInstanceOf(Response);
    expect(result.headers.get("Location")).toBe("/login");
    expect(result.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });
});

describe("Logout route - action", () => {
  beforeEach(() => {
    process.env["API_BASE_URL"] = "http://localhost:3000";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env["API_BASE_URL"];
  });

  it("revokes the server session before clearing the cookie", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const request = new Request("http://localhost/logout", { method: "POST" });
    vi.spyOn(request.headers, "get").mockImplementation((name) =>
      name.toLowerCase() === "cookie" ? "slb_session=session-token-123" : null,
    );
    const args = { request, params: {}, context: {} } as unknown as ActionFunctionArgs;

    const result = await action(args);

    expect(fetchMock).toHaveBeenCalledWith("http://localhost:3000/auth/logout", {
      method: "POST",
      headers: { Cookie: "slb_session=session-token-123" },
    });

    expect(result).toBeInstanceOf(Response);
    expect(result.headers.get("Location")).toBe("/login");
    expect(result.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });
});
