import RPReporter from "@reportportal/agent-js-vitest";

export type ReportPortalLayer = "unit" | "integration";

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

/** ReportPortal reporter for Vitest; empty when REPORTPORTAL_* env vars are unset. */
export function reportPortalReporters(
  layer: ReportPortalLayer,
): InstanceType<typeof RPReporter>[] {
  const env = readReportPortalEnv();
  if (!env) {
    return [];
  }

  const launch = layer === "unit" ? "Unit Tests" : "Integration Tests";
  const mode = process.env.CI === "true" ? "DEFAULT" : "DEBUG";

  return [
    new RPReporter({
      apiKey: env.apiKey,
      endpoint: env.endpoint,
      project: env.project,
      launch,
      mode,
      attributes: [
        { key: "layer", value: layer },
        { key: "edition", value: "hosted" },
      ],
    }),
  ];
}
