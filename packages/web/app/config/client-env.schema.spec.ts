import { describe, expect, it } from "vitest";

import { validateClientEnvConfig } from "./client-env.schema.js";

describe("validateClientEnvConfig", () => {
  it("accepts unset VITE_MARKETING_ORIGIN", () => {
    expect(validateClientEnvConfig({})).toEqual({});
  });

  it("accepts empty VITE_MARKETING_ORIGIN", () => {
    expect(validateClientEnvConfig({ VITE_MARKETING_ORIGIN: "" })).toEqual({});
  });

  it("accepts a valid marketing origin URL", () => {
    expect(
      validateClientEnvConfig({
        VITE_MARKETING_ORIGIN: "https://www.example.com",
      }),
    ).toEqual({ VITE_MARKETING_ORIGIN: "https://www.example.com" });
  });

  it("accepts unset VITE_DOCS_BASE_URL", () => {
    expect(validateClientEnvConfig({})).toEqual({});
  });

  it("accepts a valid docs base URL", () => {
    expect(
      validateClientEnvConfig({
        VITE_DOCS_BASE_URL: "https://docs.example.com",
      }),
    ).toEqual({ VITE_DOCS_BASE_URL: "https://docs.example.com" });
  });

  it("rejects an invalid marketing origin URL", () => {
    expect(() =>
      validateClientEnvConfig({ VITE_MARKETING_ORIGIN: "not-a-url" }),
    ).toThrow();
  });

  it("rejects unknown keys", () => {
    expect(() =>
      validateClientEnvConfig({ VITE_MARKETING_ORIGIN: "https://example.com", EXTRA: "x" }),
    ).toThrow();
  });
});
