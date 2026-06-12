import type { ReporterDescription } from "@playwright/test";

export type ReportPortalEdition = "hosted" | "self-hosted";

type ReportPortalEnv = {
  apiKey: string;
  endpoint: string;
  project: string;
};

function readReportPortalEnv(): ReportPortalEnv | null {
  const url = process.env.REPORTPORTAL_URL?.trim();
  const apiKey = process.env.REPORTPORTAL_API_KEY?.trim();
  const project = process.env.REPORTPORTAL_PROJECT?.trim();

  if (!url || !apiKey || !project) {
    return null;
  }

  const endpoint = url.endsWith("/api/v2")
    ? url
    : `${url.replace(/\/$/, "")}/api/v2`;

  return { apiKey, endpoint, project };
}

/** Playwright `--project` flag when a single edition is selected (e2e.sh passes this). */
export function detectPlaywrightEdition(): ReportPortalEdition | null {
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

/** ReportPortal reporter for Playwright; empty when REPORTPORTAL_* env vars are unset. */
export function reportPortalPlaywrightReporter(
  edition: ReportPortalEdition,
): ReporterDescription[] {
  const env = readReportPortalEnv();
  if (!env) {
    return [];
  }

  const mode = process.env.CI === "true" ? "DEFAULT" : "DEBUG";

  return [
    [
      "@reportportal/agent-js-playwright",
      {
        apiKey: env.apiKey,
        endpoint: env.endpoint,
        project: env.project,
        launch: "E2E Tests",
        mode,
        attributes: [
          { key: "layer", value: "e2e" },
          { key: "edition", value: edition },
        ],
      },
    ],
  ];
}
