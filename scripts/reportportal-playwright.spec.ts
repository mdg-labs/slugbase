import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  detectPlaywrightEdition,
  reportPortalPlaywrightAttributes,
  reportPortalPlaywrightLaunchName,
  reportPortalPlaywrightReporter,
  reportPortalPlaywrightReporterConfig,
} from "./reportportal-playwright.js";
import { isolateReportPortalCiEnv } from "./reportportal-test-env.js";

const REQUIRED_ENV = {
  REPORTPORTAL_URL: "https://reportportal.example.com",
  REPORTPORTAL_PROJECT: "slugbase",
  REPORTPORTAL_API_KEY: "test-api-key",
} as const;

describe("detectPlaywrightEdition", () => {
  const originalArgv = process.argv;

  afterEach(() => {
    process.argv = originalArgv;
  });

  it("returns hosted or self-hosted from --project", () => {
    process.argv = ["node", "playwright", "test", "--project=hosted"];
    expect(detectPlaywrightEdition()).toBe("hosted");

    process.argv = ["node", "playwright", "test", "--project", "self-hosted"];
    expect(detectPlaywrightEdition()).toBe("self-hosted");
  });

  it("returns null when --project is missing or unknown", () => {
    process.argv = ["node", "playwright", "test"];
    expect(detectPlaywrightEdition()).toBeNull();

    process.argv = ["node", "playwright", "test", "--project=chromium"];
    expect(detectPlaywrightEdition()).toBeNull();
  });
});

describe("reportPortalPlaywrightAttributes", () => {
  beforeEach(() => {
    isolateReportPortalCiEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("includes layer, edition, repo, and CI metadata", () => {
    vi.stubEnv("GITHUB_SHA", "abc123");

    expect(reportPortalPlaywrightAttributes("hosted")).toEqual([
      { key: "layer", value: "e2e" },
      { key: "edition", value: "hosted" },
      { key: "repo", value: "slugbase" },
      { key: "github_sha", value: "abc123" },
    ]);
  });
});

describe("reportPortalPlaywrightReporterConfig", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns null when ReportPortal env is incomplete", () => {
    expect(reportPortalPlaywrightReporterConfig("hosted")).toBeNull();
  });

  it("builds launch config per edition", () => {
    for (const [key, value] of Object.entries(REQUIRED_ENV)) {
      vi.stubEnv(key, value);
    }
    vi.stubEnv("CI", "true");

    expect(reportPortalPlaywrightReporterConfig("hosted")).toEqual({
      apiKey: REQUIRED_ENV.REPORTPORTAL_API_KEY,
      endpoint: "https://reportportal.example.com/api/v2",
      project: REQUIRED_ENV.REPORTPORTAL_PROJECT,
      launch: reportPortalPlaywrightLaunchName("hosted"),
      mode: "DEFAULT",
      attributes: reportPortalPlaywrightAttributes("hosted"),
      launchUuidPrint: true,
      launchUuidPrintOutput: "STDOUT",
    });

    expect(reportPortalPlaywrightReporterConfig("self-hosted")?.launch).toBe(
      reportPortalPlaywrightLaunchName("self-hosted"),
    );
  });
});

describe("reportPortalPlaywrightReporter", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns an empty array when env is unset", () => {
    expect(reportPortalPlaywrightReporter("hosted")).toEqual([]);
  });

  it("returns the ReportPortal tuple reporter when env is set", () => {
    for (const [key, value] of Object.entries(REQUIRED_ENV)) {
      vi.stubEnv(key, value);
    }

    const reporters = reportPortalPlaywrightReporter("hosted");
    expect(reporters).toHaveLength(1);
    expect(reporters[0]?.[0]).toBe("@reportportal/agent-js-playwright");
    expect(reporters[0]?.[1]).toMatchObject({
      launch: reportPortalPlaywrightLaunchName("hosted"),
      project: REQUIRED_ENV.REPORTPORTAL_PROJECT,
    });
  });
});
