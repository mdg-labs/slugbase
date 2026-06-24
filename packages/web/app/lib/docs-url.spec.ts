import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildDocsIntroductionUrl,
  getDocsBaseUrl,
  isCloudDocsBuild,
  parseDocsBaseUrl,
} from "./docs-url.js";

describe("parseDocsBaseUrl", () => {
  it("returns the production default when unset or empty", () => {
    expect(parseDocsBaseUrl(undefined)).toBe("https://docs.slugbase.app");
    expect(parseDocsBaseUrl("")).toBe("https://docs.slugbase.app");
    expect(parseDocsBaseUrl("   ")).toBe("https://docs.slugbase.app");
  });

  it("strips trailing slashes", () => {
    expect(parseDocsBaseUrl("https://docs.example.com/")).toBe(
      "https://docs.example.com",
    );
  });
});

describe("getDocsBaseUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses VITE_DOCS_BASE_URL when set", () => {
    vi.stubEnv("VITE_DOCS_BASE_URL", "https://docs.example.com/");
    expect(getDocsBaseUrl()).toBe("https://docs.example.com");
  });

  it("falls back to the production default when unset", () => {
    vi.stubEnv("VITE_DOCS_BASE_URL", "");
    expect(getDocsBaseUrl()).toBe("https://docs.slugbase.app");
  });
});

describe("isCloudDocsBuild", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns false when VITE_BILLING_ENABLED is unset", () => {
    vi.stubEnv("VITE_BILLING_ENABLED", "");
    expect(isCloudDocsBuild()).toBe(false);
  });

  it("returns true when VITE_BILLING_ENABLED is true", () => {
    vi.stubEnv("VITE_BILLING_ENABLED", "true");
    expect(isCloudDocsBuild()).toBe(true);
  });
});

describe("buildDocsIntroductionUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("builds CE introduction URL for self-hosted builds", () => {
    vi.stubEnv("VITE_BILLING_ENABLED", "false");
    expect(buildDocsIntroductionUrl()).toBe(
      "https://docs.slugbase.app/ce/introduction",
    );
  });

  it("builds cloud introduction URL for hosted builds", () => {
    vi.stubEnv("VITE_BILLING_ENABLED", "true");
    expect(buildDocsIntroductionUrl()).toBe(
      "https://docs.slugbase.app/cloud/introduction",
    );
  });

  it("honors a custom docs base URL", () => {
    vi.stubEnv("VITE_DOCS_BASE_URL", "https://docs.example.com");
    vi.stubEnv("VITE_BILLING_ENABLED", "false");
    expect(buildDocsIntroductionUrl()).toBe(
      "https://docs.example.com/ce/introduction",
    );
  });
});
