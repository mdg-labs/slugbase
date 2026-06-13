import type { ReporterDescription } from "@playwright/test";
import {
  readReportPortalEnv,
  reportPortalCiAttributes,
  reportPortalEndpoint,
  reportPortalMode,
} from "./reportportal-vitest.js";

export type PlaywrightEdition = "hosted" | "self-hosted";

type ReportPortalMode = "DEFAULT" | "DEBUG";

type ReportPortalAttribute = {
  key?: string;
  value: string;
};

type ReportPortalPlaywrightConfig = {
  apiKey: string;
  endpoint: string;
  project: string;
  launch: string;
  mode: ReportPortalMode;
  attributes: ReportPortalAttribute[];
  launchUuidPrint: boolean;
  launchUuidPrintOutput: "STDOUT";
};

const E2E_LAUNCH_PREFIX = "SlugBase · E2E";

export function reportPortalPlaywrightLaunchName(
  edition: PlaywrightEdition,
): string {
  return `${E2E_LAUNCH_PREFIX} · ${edition}`;
}

/** Playwright `--project` flag when a single edition is selected (e2e.sh passes this). */
export function detectPlaywrightEdition(): PlaywrightEdition | null {
  const args = process.argv;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg.startsWith("--project=")) {
      const name = arg.slice("--project=".length);
      return name === "hosted" || name === "self-hosted" ? name : null;
    }

    if (arg === "--project" && i + 1 < args.length) {
      const name = args[i + 1];
      return name === "hosted" || name === "self-hosted" ? name : null;
    }
  }

  return null;
}

export function reportPortalPlaywrightAttributes(
  edition: PlaywrightEdition,
): ReportPortalAttribute[] {
  return [
    { key: "layer", value: "e2e" },
    { key: "edition", value: edition },
    { key: "repo", value: "slugbase" },
    ...reportPortalCiAttributes(),
  ];
}

export function reportPortalPlaywrightReporterConfig(
  edition: PlaywrightEdition,
): ReportPortalPlaywrightConfig | null {
  const env = readReportPortalEnv();
  if (!env) {
    return null;
  }

  return {
    apiKey: env.apiKey,
    endpoint: reportPortalEndpoint(env.url),
    project: env.project,
    launch: reportPortalPlaywrightLaunchName(edition),
    mode: reportPortalMode(),
    attributes: reportPortalPlaywrightAttributes(edition),
    launchUuidPrint: true,
    launchUuidPrintOutput: "STDOUT",
  };
}

/** ReportPortal reporter for Playwright e2e; no-ops when REPORTPORTAL_* env is incomplete. */
export function reportPortalPlaywrightReporter(
  edition: PlaywrightEdition,
): ReporterDescription[] {
  const config = reportPortalPlaywrightReporterConfig(edition);
  if (!config) {
    return [];
  }

  return [
    [
      "@reportportal/agent-js-playwright",
      config as Record<string, unknown>,
    ],
  ];
}
