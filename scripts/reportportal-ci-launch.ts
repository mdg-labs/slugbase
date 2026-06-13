#!/usr/bin/env node
/**
 * Create or finish a single shared ReportPortal launch for CI (unit / integration).
 *
 * CI sets RP_LAUNCH_ID before turbo test tasks; Vitest reporters attach without
 * starting or finishing their own launches.
 */
import { pathToFileURL } from "node:url";
import RPClient from "@reportportal/client-javascript";
import {
  readReportPortalEnv,
  reportPortalCiAttributes,
  reportPortalEndpoint,
  reportPortalLaunchName,
  reportPortalMode,
  type ReportPortalLayer,
} from "./reportportal-config.ts";

type LaunchStatus = "passed" | "failed";

function parseLayer(value: string | undefined): ReportPortalLayer | null {
  if (value === "unit" || value === "integration") {
    return value;
  }
  return null;
}

export function parseCiLaunchStatus(value: string | undefined): LaunchStatus {
  return value === "FAILED" || value === "failed" ? "failed" : "passed";
}

function parseStatus(value: string | undefined): LaunchStatus {
  return parseCiLaunchStatus(value);
}

function createClient(layer: ReportPortalLayer): RPClient | null {
  const env = readReportPortalEnv();
  if (!env) {
    return null;
  }

  return new RPClient({
    apiKey: env.apiKey,
    endpoint: reportPortalEndpoint(env.url),
    project: env.project,
    launch: reportPortalLaunchName(layer),
    mode: reportPortalMode(),
  });
}

export async function startCiLaunch(layer: ReportPortalLayer): Promise<string | null> {
  const client = createClient(layer);
  if (!client) {
    return null;
  }

  const attributes = [
    { key: "layer", value: layer },
    { key: "repo", value: "slugbase" },
    ...reportPortalCiAttributes(),
  ];

  const { promise } = client.startLaunch({
    name: reportPortalLaunchName(layer),
    description: `SlugBase monorepo ${layer} tests (CI)`,
    attributes,
    mode: reportPortalMode(),
  });

  const response = (await promise) as { id: string };
  return response.id;
}

export async function finishCiLaunch(
  layer: ReportPortalLayer,
  uuid: string,
  status: LaunchStatus,
): Promise<void> {
  const client = createClient(layer);
  if (!client) {
    return;
  }

  const { tempId, promise } = client.startLaunch({ id: uuid });
  await promise;

  const finishPromise = client.finishLaunch(tempId, {
    endTime: Date.now(),
    status,
  });
  await finishPromise.promise;
}

async function main(): Promise<void> {
  const [command, layerArg, uuidArg, statusArg] = process.argv.slice(2);
  const layer = parseLayer(layerArg);

  if (!layer) {
    console.error(
      "usage: reportportal-ci-launch.ts <start|finish> <unit|integration> [uuid] [PASSED|FAILED]",
    );
    process.exit(1);
  }

  if (command === "start") {
    const uuid = await startCiLaunch(layer);
    if (!uuid) {
      process.exit(0);
    }
    process.stdout.write(uuid);
    return;
  }

  if (command === "finish") {
    if (!uuidArg) {
      console.error("finish requires launch uuid");
      process.exit(1);
    }
    await finishCiLaunch(layer, uuidArg, parseStatus(statusArg));
    return;
  }

  console.error("unknown command:", command);
  process.exit(1);
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
