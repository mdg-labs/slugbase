import { RPReporter } from "@reportportal/agent-js-vitest";

export type ReportPortalLayer = "unit" | "integration";

/** Agent constructor config (includes undocumented launchUuidPrint* fields used at runtime). */
type ReportPortalClientConfig = ConstructorParameters<typeof RPReporter>[0];

type ReportPortalVitestConfig = ReportPortalClientConfig & {
  launchUuidPrint: boolean;
  launchUuidPrintOutput: "STDOUT";
};

type ReportPortalAttribute = {
  key?: string;
  value: string;
};

type ReportPortalEnv = {
  url: string;
  project: string;
  apiKey: string;
};

const LAUNCH_MODE_DEFAULT = "DEFAULT" as NonNullable<ReportPortalClientConfig["mode"]>;
const LAUNCH_MODE_DEBUG = "DEBUG" as NonNullable<ReportPortalClientConfig["mode"]>;

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

export function reportPortalMode(): NonNullable<ReportPortalClientConfig["mode"]> {
  return process.env.CI === "true" ? LAUNCH_MODE_DEFAULT : LAUNCH_MODE_DEBUG;
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

export function reportPortalReporterConfig(
  layer: ReportPortalLayer,
  packageName: string,
): ReportPortalVitestConfig | null {
  const env = readReportPortalEnv();
  if (!env) {
    return null;
  }

  return {
    apiKey: env.apiKey,
    endpoint: reportPortalEndpoint(env.url),
    project: env.project,
    launch: LAUNCH_NAMES[layer],
    mode: reportPortalMode(),
    attributes: reportPortalAttributes(layer, packageName),
    launchUuidPrint: true,
    launchUuidPrintOutput: "STDOUT",
  };
}

/** ReportPortal reporter for Vitest; no-ops when REPORTPORTAL_* env is incomplete. */
export function reportPortalReporters(
  layer: ReportPortalLayer,
  packageName: string,
): RPReporter[] {
  const config = reportPortalReporterConfig(layer, packageName);
  if (!config) {
    return [];
  }

  return [new RPReporter(config as ReportPortalClientConfig)];
}
