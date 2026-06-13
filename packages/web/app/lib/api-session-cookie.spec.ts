import { afterEach, describe, expect, it, vi } from "vitest";

import { authCookieSecure } from "./api-session-cookie.js";

describe("authCookieSecure", () => {
  const originalE2eMode = process.env.SLUGBASE_E2E_MODE;
  const originalApiBaseUrl = process.env.API_BASE_URL;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (originalE2eMode === undefined) {
      delete process.env.SLUGBASE_E2E_MODE;
    } else {
      process.env.SLUGBASE_E2E_MODE = originalE2eMode;
    }
    if (originalApiBaseUrl === undefined) {
      delete process.env.API_BASE_URL;
    } else {
      process.env.API_BASE_URL = originalApiBaseUrl;
    }
  });

  it("returns false when API_BASE_URL uses http", () => {
    delete process.env.SLUGBASE_E2E_MODE;
    vi.stubEnv("VITE_APP_BASE_URL", "");
    process.env.API_BASE_URL = "http://slugbase.local:3000";
    expect(authCookieSecure()).toBe(false);
  });

  it("returns true when API_BASE_URL uses https", () => {
    delete process.env.SLUGBASE_E2E_MODE;
    vi.stubEnv("VITE_APP_BASE_URL", "");
    process.env.API_BASE_URL = "https://slugbase.example.com";
    expect(authCookieSecure()).toBe(true);
  });

  it("returns false when SLUGBASE_E2E_MODE is set", () => {
    process.env.SLUGBASE_E2E_MODE = "true";
    vi.stubEnv("VITE_APP_BASE_URL", "https://slugbase.example.com");
    expect(authCookieSecure()).toBe(false);
  });
});
