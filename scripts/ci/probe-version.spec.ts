import { describe, expect, it, vi } from "vitest";
import {
  BOOTSTRAP_VERSION,
  classifyProbeStatus,
  parseVersionBody,
  probeLiveVersion,
  semverGt,
  semverGte,
} from "./probe-version.mjs";

describe("probe-version", () => {
  it("classifies unreachable statuses as bootstrap", () => {
    expect(classifyProbeStatus(403, "staging")).toBe("bootstrap");
    expect(classifyProbeStatus(403, "production")).toBe("bootstrap");
    expect(classifyProbeStatus(404, "staging")).toBe("bootstrap");
    expect(classifyProbeStatus(502, "production")).toBe("bootstrap");
  });

  it("parses version JSON body", () => {
    expect(parseVersionBody({ version: "1.2.3" })).toBe("1.2.3");
    expect(parseVersionBody({ status: "ok" })).toBeNull();
  });

  it("semverGt compares dotted versions", () => {
    expect(semverGt("1.0.1", "1.0.0")).toBe(true);
    expect(semverGt("1.0.0", "1.0.0")).toBe(false);
    expect(semverGte("1.0.0", "1.0.0")).toBe(true);
  });

  it("returns live version on HTTP 200", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ version: "0.9.0" }),
    });

    const result = await probeLiveVersion({
      origin: "https://api.example.test",
      environment: "production",
      fetchFn,
      maxAttempts: 1,
    });

    expect(result).toEqual({
      liveVersion: "0.9.0",
      bootstrapped: false,
      httpStatus: 200,
    });
  });

  it("bootstraps 0.0.0 after retries on 404", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ status: 404 });

    const result = await probeLiveVersion({
      origin: "https://api.example.test",
      environment: "production",
      fetchFn,
      maxAttempts: 2,
      initialDelayMs: 1,
    });

    expect(result.liveVersion).toBe(BOOTSTRAP_VERSION);
    expect(result.bootstrapped).toBe(true);
  });

  it("bootstraps staging HTTP 403 without CF Access headers", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ status: 403 });

    const result = await probeLiveVersion({
      origin: "https://api.example.test",
      environment: "staging",
      fetchFn,
      maxAttempts: 1,
    });

    expect(result.liveVersion).toBe(BOOTSTRAP_VERSION);
    expect(result.bootstrapped).toBe(true);
    expect(fetchFn).toHaveBeenCalledWith(
      "https://api.example.test/version",
      expect.objectContaining({
        headers: { Accept: "application/json" },
      }),
    );
  });
});
