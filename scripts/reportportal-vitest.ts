import { RPReporter } from "@reportportal/agent-js-vitest";
import { ReportPortalVitest4Reporter } from "./reportportal-vitest4-adapter.js";
import {
  readReportPortalEnv,
  reportPortalAttributes,
  reportPortalEndpoint,
  reportPortalLaunchName,
  reportPortalMode,
  type ReportPortalLayer,
} from "./reportportal-config.js";

export type { ReportPortalLayer } from "./reportportal-config.js";
export {
  readReportPortalEnv,
  reportPortalAttributes,
  reportPortalCiAttributes,
  reportPortalEndpoint,
  reportPortalLaunchName,
  reportPortalMode,
} from "./reportportal-config.js";

/** Agent constructor config (includes undocumented launchUuidPrint* fields used at runtime). */
type ReportPortalClientConfig = ConstructorParameters<typeof RPReporter>[0];

type ReportPortalVitestConfig = ReportPortalClientConfig & {
  launchUuidPrint: boolean;
  launchUuidPrintOutput: "STDOUT";
};

function trimEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function reportPortalReporterConfig(
  layer: ReportPortalLayer,
  packageName: string,
): ReportPortalVitestConfig | null {
  const env = readReportPortalEnv();
  if (!env) {
    return null;
  }

  const sharedLaunchId = trimEnv(process.env.RP_LAUNCH_ID);

  return {
    apiKey: env.apiKey,
    endpoint: reportPortalEndpoint(env.url),
    project: env.project,
    launch: reportPortalLaunchName(layer),
    mode: reportPortalMode() as NonNullable<ReportPortalClientConfig["mode"]>,
    attributes: reportPortalAttributes(layer, packageName),
    launchId: sharedLaunchId,
    launchUuidPrint: !sharedLaunchId,
    launchUuidPrintOutput: "STDOUT",
  };
}

/** ReportPortal reporter for Vitest; no-ops when REPORTPORTAL_* env is incomplete. */
export function reportPortalReporters(
  layer: ReportPortalLayer,
  packageName: string,
): ReportPortalVitest4Reporter[] {
  const config = reportPortalReporterConfig(layer, packageName);
  if (!config) {
    return [];
  }

  return [new ReportPortalVitest4Reporter(config as ReportPortalClientConfig)];
}
