export type ReportPortalLayer = "unit" | "integration";

type ReportPortalAttribute = {
  key?: string;
  value: string;
};

type ReportPortalEnv = {
  url: string;
  project: string;
  apiKey: string;
};

/** Matches @reportportal/agent-js-vitest LAUNCH_MODES string values. */
export const REPORTPORTAL_LAUNCH_MODE = {
  default: "DEFAULT",
  debug: "DEBUG",
} as const;

export type ReportPortalLaunchMode =
  (typeof REPORTPORTAL_LAUNCH_MODE)[keyof typeof REPORTPORTAL_LAUNCH_MODE];

const LAUNCH_NAMES: Record<ReportPortalLayer, string> = {
  unit: "SlugBase · Unit",
  integration: "SlugBase · Integration",
};

const CI_ATTRIBUTE_KEYS = [
  ["github_sha", "GITHUB_SHA"],
  ["github_ref", "GITHUB_REF"],
  ["github_run_id", "GITHUB_RUN_ID"],
  ["github_run_number", "GITHUB_RUN_NUMBER"],
  ["github_workflow", "GITHUB_WORKFLOW"],
] as const;

function trimEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function readReportPortalEnv(): ReportPortalEnv | null {
  const url = trimEnv(process.env.REPORTPORTAL_URL);
  const project = trimEnv(process.env.REPORTPORTAL_PROJECT);
  const apiKey = trimEnv(process.env.REPORTPORTAL_API_KEY);

  if (!url || !project || !apiKey) {
    return null;
  }

  return { url, project, apiKey };
}

export function reportPortalEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/api/v2`;
}

export function reportPortalMode(): ReportPortalLaunchMode {
  return process.env.CI === "true"
    ? REPORTPORTAL_LAUNCH_MODE.default
    : REPORTPORTAL_LAUNCH_MODE.debug;
}

export function reportPortalLaunchName(layer: ReportPortalLayer): string {
  const base = LAUNCH_NAMES[layer];
  const runNumber = trimEnv(process.env.GITHUB_RUN_NUMBER);
  if (process.env.CI === "true" && runNumber) {
    return `${base} · CI #${runNumber}`;
  }
  return base;
}

export function reportPortalCiAttributes(): ReportPortalAttribute[] {
  const attributes: ReportPortalAttribute[] = [];

  for (const [key, envName] of CI_ATTRIBUTE_KEYS) {
    const value = trimEnv(process.env[envName]);
    if (value) {
      attributes.push({ key, value });
    }
  }

  return attributes;
}

export function reportPortalAttributes(
  layer: ReportPortalLayer,
  packageName: string,
): ReportPortalAttribute[] {
  return [
    { key: "layer", value: layer },
    { key: "repo", value: "slugbase" },
    { key: "package", value: packageName },
    ...reportPortalCiAttributes(),
  ];
}
