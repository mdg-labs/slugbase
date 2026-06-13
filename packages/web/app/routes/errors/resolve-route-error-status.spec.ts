import { data } from "react-router";
import { describe, expect, it } from "vitest";
import { resolveRouteErrorStatus } from "./resolve-route-error-status.js";

describe("resolveRouteErrorStatus", () => {
  it("maps route error responses to known statuses", () => {
    expect(resolveRouteErrorStatus(data(null, { status: 404 }))).toBe(404);
    expect(resolveRouteErrorStatus(data(null, { status: 403 }))).toBe(403);
    expect(resolveRouteErrorStatus(data(null, { status: 500 }))).toBe(500);
    expect(
      resolveRouteErrorStatus({
        status: 404,
        statusText: "Not Found",
        data: null,
        internal: false,
      }),
    ).toBe(404);
  });

  it("defaults unknown errors to 500", () => {
    expect(resolveRouteErrorStatus(new Error("fail"))).toBe(500);
    expect(resolveRouteErrorStatus(data(null, { status: 502 }))).toBe(500);
  });
});
