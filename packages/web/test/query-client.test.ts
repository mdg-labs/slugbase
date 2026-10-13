import { describe, expect, it } from "vitest";
import { ApiProblemError } from "../src/api/client.ts";
import { shouldRetry } from "../src/query-client.ts";

const problemOf = (status: number) => new ApiProblemError({ code: "internal", status, requestId: "r" });

describe("shouldRetry", () => {
  it("does not repeat a request the server refused with a 4xx problem", () => {
    expect(shouldRetry(0, problemOf(404))).toBe(false);
  });

  it("retries a 5xx problem and a transport failure a limited number of times", () => {
    expect(shouldRetry(0, problemOf(503))).toBe(true);
    expect(shouldRetry(1, new TypeError("network"))).toBe(true);
    expect(shouldRetry(2, new TypeError("network"))).toBe(false);
  });
});
