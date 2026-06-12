import { describe, expect, it } from "vitest";
import type { Request } from "express";

import { shouldServeWebClient } from "./mount-web-client.js";

function mockRequest(
  overrides: Partial<Request> & Pick<Request, "method" | "path">,
): Request {
  return {
    headers: {},
    ...overrides,
  } as Request;
}

describe("shouldServeWebClient", () => {
  it("serves HTML document GETs for app routes", () => {
    expect(
      shouldServeWebClient(
        mockRequest({
          method: "GET",
          path: "/login",
          headers: { accept: "text/html" },
        }),
      ),
    ).toBe(true);
  });

  it("routes React Router single-fetch requests to the web client", () => {
    expect(
      shouldServeWebClient(
        mockRequest({
          method: "GET",
          path: "/_root.data",
          headers: { accept: "application/json" },
        }),
      ),
    ).toBe(true);
  });

  it("routes React Router lazy route manifest to the web client", () => {
    expect(
      shouldServeWebClient(
        mockRequest({
          method: "GET",
          path: "/__manifest",
          headers: { accept: "application/json" },
        }),
      ),
    ).toBe(true);
  });

  it("routes /api proxy paths to the web client", () => {
    expect(
      shouldServeWebClient(
        mockRequest({
          method: "POST",
          path: "/api/bookmarks",
          headers: { "content-type": "application/json", accept: "application/json" },
        }),
      ),
    ).toBe(true);
  });

  it("passes JSON API GETs to Nest", () => {
    expect(
      shouldServeWebClient(
        mockRequest({
          method: "GET",
          path: "/bookmarks",
          headers: { accept: "application/json" },
        }),
      ),
    ).toBe(false);
  });

  it("keeps API-only GET paths on Nest even with HTML accept", () => {
    expect(
      shouldServeWebClient(
        mockRequest({
          method: "GET",
          path: "/health",
          headers: { accept: "text/html" },
        }),
      ),
    ).toBe(false);
  });

  it("routes HTML form posts to React Router", () => {
    expect(
      shouldServeWebClient(
        mockRequest({
          method: "POST",
          path: "/login",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
          },
        }),
      ),
    ).toBe(true);
  });

  it("passes JSON POST mutations to Nest", () => {
    expect(
      shouldServeWebClient(
        mockRequest({
          method: "POST",
          path: "/auth/login",
          headers: { "content-type": "application/json" },
        }),
      ),
    ).toBe(false);
  });
});
