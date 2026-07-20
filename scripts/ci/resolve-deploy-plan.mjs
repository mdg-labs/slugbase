/**
 * Deploy plan from live /version probes (ci-cd refactor #549).
 */

import { appendFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  resolveDeployProbeOrigins,
  toDeployPlanOrigins,
} from "./deploy-probe-origins.mjs";
import {
  BOOTSTRAP_VERSION,
  probeLiveVersion,
  semverGt,
  semverGte,
} from "./probe-version.mjs";

/** @typedef {'staging' | 'production'} DeployEnvironment */

/** @typedef {'auto' | 'manual'} DeployMode */

/**
 * @typedef {object} DeployPlan
 * @property {boolean} deploy_api
 * @property {boolean} deploy_web
 * @property {boolean} deploy_marketing
 * @property {boolean} deploy_admin
 * @property {boolean} run_migrate
 * @property {boolean} run_migrate_admin
 * @property {boolean} push_ghcr_api
 * @property {boolean} push_ghcr_web
 * @property {boolean} deployed_api
 * @property {boolean} deployed_web
 */

/**
 * @typedef {object} SurfaceConfig
 * @property {string} id
 * @property {string} packageName
 * @property {string} pkgDir
 * @property {keyof DeployPlan} deployFlag
 * @property {Array<keyof DeployPlan>} relatedFlags
 */

export const PRODUCTION_MIN_VERSION = "1.0.0";

/** @type {SurfaceConfig[]} */
export const SURFACES = [
  {
    id: "api",
    packageName: "@slugbase/backend",
    pkgDir: "packages/backend",
    deployFlag: "deploy_api",
    relatedFlags: ["run_migrate", "push_ghcr_api"],
  },
  {
    id: "web",
    packageName: "@slugbase/web",
    pkgDir: "packages/web",
    deployFlag: "deploy_web",
    relatedFlags: ["push_ghcr_web"],
  },
  {
    id: "marketing",
    packageName: "@slugbase/marketing",
    pkgDir: "packages/marketing",
    deployFlag: "deploy_marketing",
    relatedFlags: [],
  },
  {
    id: "admin",
    packageName: "@slugbase/admin",
    pkgDir: "packages/admin",
    deployFlag: "deploy_admin",
    relatedFlags: ["run_migrate_admin"],
  },
];

/**
 * @returns {DeployPlan}
 */
export function createEmptyPlan() {
  return {
    deploy_api: false,
    deploy_web: false,
    deploy_marketing: false,
    deploy_admin: false,
    run_migrate: false,
    run_migrate_admin: false,
    push_ghcr_api: false,
    push_ghcr_web: false,
    deployed_api: false,
    deployed_web: false,
  };
}

/**
 * @param {string} repoRoot
 * @returns {Record<string, string>}
 */
export function readPackageVersions(repoRoot) {
  const packagesDir = join(repoRoot, "packages");
  /** @type {Record<string, string>} */
  const versions = {};
  for (const entry of readdirSync(packagesDir)) {
    const pkgDir = join(packagesDir, entry);
    const manifestPath = join(pkgDir, "package.json");
    try {
      if (!statSync(pkgDir).isDirectory()) {
        continue;
      }
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (manifest.name && manifest.version) {
        versions[manifest.name] = manifest.version;
      }
    } catch {
      // skip non-packages
    }
  }
  return versions;
}

/**
 * @param {DeployPlan} plan
 * @param {SurfaceConfig} surface
 * @param {boolean} shouldDeploy
 */
function setSurfaceDeploy(plan, surface, shouldDeploy) {
  plan[surface.deployFlag] = shouldDeploy;
  for (const flag of surface.relatedFlags) {
    plan[flag] = shouldDeploy;
  }
}

/**
 * @param {object} input
 * @param {DeployEnvironment} input.environment
 * @param {DeployMode} input.deployMode
 * @param {Record<string, string>} input.packageVersions
 * @param {Record<string, string | undefined>} input.origins
 * @param {typeof fetch} [input.fetchFn]
 * @param {number} [input.maxAttempts]
 * @param {number} [input.initialDelayMs]
 * @returns {Promise<{ plan: DeployPlan; skipReasons: string[]; log: string[] }>}
 */
export async function resolveDeployPlan(input) {
  const plan = createEmptyPlan();
  /** @type {string[]} */
  const skipReasons = [];
  /** @type {string[]} */
  const log = [];

  for (const surface of SURFACES) {
    const intended =
      input.packageVersions[surface.packageName] ?? BOOTSTRAP_VERSION;
    const origin = input.origins[surface.id]?.trim();

    if (!origin) {
      const reason = `${surface.id}: skipped — missing origin URL`;
      skipReasons.push(reason);
      log.push(reason);
      continue;
    }

    if (
      input.environment === "production" &&
      !semverGte(intended, PRODUCTION_MIN_VERSION)
    ) {
      const reason = `${surface.id}: skipped — ${surface.packageName}@${intended} < ${PRODUCTION_MIN_VERSION} (production gate)`;
      skipReasons.push(reason);
      log.push(reason);
      continue;
    }

    if (input.deployMode === "manual") {
      setSurfaceDeploy(plan, surface, true);
      log.push(`${surface.id}: deploy (manual mode — live compare skipped)`);
      continue;
    }

    const probe = await probeLiveVersion({
      origin,
      environment: input.environment,
      fetchFn: input.fetchFn,
      maxAttempts: input.maxAttempts,
      initialDelayMs: input.initialDelayMs,
    });

    if (probe.bootstrapped) {
      log.push(
        `${surface.id}: live version unreachable — bootstrapped ${BOOTSTRAP_VERSION}`,
      );
    } else {
      log.push(`${surface.id}: live version ${probe.liveVersion}`);
    }

    if (semverGt(intended, probe.liveVersion)) {
      setSurfaceDeploy(plan, surface, true);
      log.push(
        `${surface.id}: deploy — intended ${intended} > live ${probe.liveVersion}`,
      );
    } else {
      const reason = `${surface.id}: skipped — intended ${intended} <= live ${probe.liveVersion}`;
      skipReasons.push(reason);
      log.push(reason);
    }
  }

  return { plan, skipReasons, log };
}

/**
 * @param {DeployPlan} plan
 * @returns {Record<string, string>}
 */
export function formatGithubOutputs(plan) {
  return {
    deploy_api: String(plan.deploy_api),
    deploy_web: String(plan.deploy_web),
    deploy_marketing: String(plan.deploy_marketing),
    deploy_admin: String(plan.deploy_admin),
    run_migrate: String(plan.run_migrate),
    run_migrate_admin: String(plan.run_migrate_admin),
    push_ghcr_api: String(plan.push_ghcr_api),
    push_ghcr_web: String(plan.push_ghcr_web),
    deployed_api: String(plan.deployed_api),
    deployed_web: String(plan.deployed_web),
  };
}

/**
 * @param {DeployPlan} plan
 * @param {string[]} skipReasons
 */
export function writeGithubOutput(plan, skipReasons) {
  const outputs = formatGithubOutputs(plan);
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (!githubOutput) {
    for (const [key, value] of Object.entries(outputs)) {
      process.stdout.write(`${key}=${value}\n`);
    }
    return;
  }
  for (const [key, value] of Object.entries(outputs)) {
    appendFileSync(githubOutput, `${key}=${value}\n`);
  }
  appendFileSync(githubOutput, `skip_reasons<<EOF\n${skipReasons.join("\n")}\nEOF\n`);
}

/**
 * CLI entry for deploy.yml plan job.
 */
export async function main() {
  const environment = process.env.ENVIRONMENT;
  if (environment !== "staging" && environment !== "production") {
    throw new Error("resolve-deploy-plan: ENVIRONMENT must be staging or production");
  }

  const deployModeRaw = process.env.DEPLOY_MODE ?? "auto";
  const deployMode = deployModeRaw === "manual" ? "manual" : "auto";
  const shouldDeploy = (process.env.SHOULD_DEPLOY ?? "true") !== "false";

  if (!shouldDeploy) {
    const plan = createEmptyPlan();
    const skipReasons = ["should_deploy=false — deploy skipped"];
    for (const line of skipReasons) {
      process.stderr.write(`resolve-deploy-plan: ${line}\n`);
    }
    writeGithubOutput(plan, skipReasons);
    return;
  }

  const forceManual =
    process.env.FORCE_FULL_DEPLOY === "true" || deployMode === "manual";
  const effectiveMode = forceManual ? "manual" : "auto";

  const repoRoot = process.cwd();
  const packageVersions = readPackageVersions(repoRoot);

  const probeOrigins = resolveDeployProbeOrigins(environment, {
    APP_BASE_URL: process.env.APP_BASE_URL,
    FRONTEND_ORIGIN: process.env.FRONTEND_ORIGIN,
    MARKETING_ORIGIN: process.env.MARKETING_ORIGIN,
    ADMIN_URL: process.env.ADMIN_URL,
  });

  for (const [key, value] of Object.entries(probeOrigins)) {
    process.stderr.write(`resolve-deploy-plan: ${key}=${value}\n`);
  }

  const origins = toDeployPlanOrigins(probeOrigins);

  const { plan, skipReasons, log } = await resolveDeployPlan({
    environment,
    deployMode: effectiveMode,
    packageVersions,
    origins,
  });

  for (const entry of log) {
    process.stderr.write(`resolve-deploy-plan: ${entry}\n`);
  }

  writeGithubOutput(plan, skipReasons);
}

const isMain = process.argv[1]?.endsWith("resolve-deploy-plan.mjs");
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
