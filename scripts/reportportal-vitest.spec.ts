import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readReportPortalEnv,
  reportPortalAttributes,
  reportPortalCiAttributes,
  reportPortalEndpoint,
  reportPortalMode,
  reportPortalReporterConfig,
  reportPortalReporters,
} from "./reportportal-vitest.ts";

const REQUIRED_ENV = {
  REPORTPORTAL_URL: "https://reportportal.example.com",
  REPORTPORTAL_PROJECT: "slugbase",
  REPORTPORTAL_API_KEY: "test-api-key",
} as const;

describe("readReportPortalEnv", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns null when any required env var is missing", () => {
    expect(readReportPortalEnv()).toBeNull();

    vi.stubEnv("REPORTPORTAL_URL", REQUIRED_ENV.REPORTPORTAL_URL);
    expect(readReportPortalEnv()).toBeNull();

    vi.stubEnv("REPORTPORTAL_PROJECT", REQUIRED_ENV.REPORTPORTAL_PROJECT);
    expect(readReportPortalEnv()).toBeNull();
  });

  it("returns trimmed values when all required env vars are set", () => {
    vi.stubEnv("REPORTPORTAL_URL", ` ${REQUIRED_ENV.REPORTPORTAL_URL} `);
    vi.stubEnv("REPORTPORTAL_PROJECT", REQUIRED_ENV.REPORTPORTAL_PROJECT);
    vi.stubEnv("REPORTPORTAL_API_KEY", REQUIRED_ENV.REPORTPORTAL_API_KEY);

    expect(readReportPortalEnv()).toEqual({
      url: REQUIRED_ENV.REPORTPORTAL_URL,
      project: REQUIRED_ENV.REPORTPORTAL_PROJECT,
      apiKey: REQUIRED_ENV.REPORTPORTAL_API_KEY,
    });
  });
});

describe("reportPortalEndpoint", () => {
  it("appends /api/v2 and strips trailing slash", () => {
    expect(reportPortalEndpoint("https://reportportal.example.com/")).toBe(
      "https://reportportal.example.com/api/v2",
    );
  });
});

describe("reportPortalMode", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses DEFAULT in CI and DEBUG locally", () => {
    vi.stubEnv("CI", "true");
    expect(reportPortalMode()).toBe("DEFAULT");

    vi.stubEnv("CI", "false");
    expect(reportPortalMode()).toBe("DEBUG");
  });
});

describe("reportPortalCiAttributes", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("includes only set CI metadata", () => {
    vi.stubEnv("GITHUB_SHA", "abc123");
    vi.stubEnv("GITHUB_RUN_NUMBER", "42");

    expect(reportPortalCiAttributes()).toEqual([
      { key: "github_sha", value: "abc123" },
      { key: "github_run_number", value: "42" },
    ]);
  });
});

describe("reportPortalReporterConfig", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns null when ReportPortal env is incomplete", () => {
    expect(reportPortalReporterConfig("unit", "backend")).toBeNull();
  });

  it("builds launch config for unit and integration layers", () => {
    for (const [key, value] of Object.entries(REQUIRED_ENV)) {
      vi.stubEnv(key, value);
    }
    vi.stubEnv("CI", "true");
    vi.stubEnv("GITHUB_SHA", "deadbeef");

    expect(reportPortalReporterConfig("unit", "backend")).toEqual({
      apiKey: REQUIRED_ENV.REPORTPORTAL_API_KEY,
      endpoint: "https://reportportal.example.com/api/v2",
      project: REQUIRED_ENV.REPORTPORTAL_PROJECT,
      launch: "SlugBase · Unit",
      mode: "DEFAULT",
      attributes: reportPortalAttributes("unit", "backend"),
      launchUuidPrint: true,
      launchUuidPrintOutput: "STDOUT",
    });

    expect(reportPortalReporterConfig("integration", "marketing")?.launch).toBe(
      "SlugBase · Integration",
    );
  });
});

describe("reportPortalReporters", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns an empty array when env is unset", () => {
    expect(reportPortalReporters("unit", "web")).toEqual([]);
  });

  it("returns an RPReporter instance when env is set", () => {
    for (const [key, value] of Object.entries(REQUIRED_ENV)) {
      vi.stubEnv(key, value);
    }

    const reporters = reportPortalReporters("unit", "web");
    expect(reporters).toHaveLength(1);
    expect(reporters[0]?.config.launch).toBe("SlugBase · Unit");
  });
});
