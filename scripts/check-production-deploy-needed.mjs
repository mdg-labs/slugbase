/**
 * Production release deploy idempotency (granular-deployment WP-8, spec §22.7).
 * Consumed by `.github/scripts/check-production-deploy-needed.sh`,
 * `detect-deploy-targets.mjs`, and unit tests.
 */

import { semverLt } from "./detect-deploy-targets.mjs";
import {
  DEPLOY_SURFACES,
  SURFACE_PACKAGES,
  parseDeployedState,
} from "./update-deployed-state.mjs";

const PRODUCTION_MIN_VERSION = "1.0.0";

/** @type {Record<import("./update-deployed-state.mjs").DeploySurface, Array<keyof import("./detect-deploy-targets.mjs").DeployTargets>>} */
export const SURFACE_TARGET_FLAGS = {
  api: ["deploy_api", "run_migrate", "push_ghcr_api"],
  web: ["deploy_web", "push_ghcr_web"],
  marketing: ["deploy_marketing"],
  admin: ["deploy_admin", "run_migrate_admin"],
};

/**
 * @param {string | undefined | null} left
 * @param {string | undefined | null} right
 * @returns {boolean}
 */
export function shaMatches(left, right) {
  if (!left || !right) {
    return false;
  }
  if (left === right) {
    return true;
  }
  const leftShort = left.slice(0, 7);
  const rightShort = right.slice(0, 7);
  return leftShort === rightShort;
}

/**
 * @param {object} input
 * @param {import("./update-deployed-state.mjs").DeploySurface} input.surface
 * @param {Record<string, string>} input.packageVersions
 * @param {import("./update-deployed-state.mjs").DeployedState} input.deployedState
 * @param {string} input.releaseSha
 * @returns {{ needsDeploy: boolean; reason: string }}
 */
export function evaluateProductionSurface({
  surface,
  packageVersions,
  deployedState,
  releaseSha,
}) {
  const mapping = SURFACE_PACKAGES[surface];
  const version = packageVersions[mapping.package] ?? "0.0.0";

  if (semverLt(version, PRODUCTION_MIN_VERSION)) {
    return {
      needsDeploy: false,
      reason: `${surface}: skipped — ${mapping.package}@${version} < ${PRODUCTION_MIN_VERSION} (production gate)`,
    };
  }

  const deployed = deployedState[surface];
  if (
    deployed &&
    deployed.version === version &&
    shaMatches(deployed.sha, releaseSha)
  ) {
    return {
      needsDeploy: false,
      reason: `${surface}: skipped — already deployed ${version}@${deployed.sha}`,
    };
  }

  return {
    needsDeploy: true,
    reason: `${surface}: deploy needed (${mapping.package}@${version})`,
  };
}

/**
 * @param {object} input
 * @param {string} input.releaseSha
 * @param {string | undefined | null} input.deployedStateJson
 * @param {Record<string, string>} input.packageVersions
 * @returns {{
 *   shouldDeploy: boolean;
 *   surfaces: Record<import("./update-deployed-state.mjs").DeploySurface, boolean>;
 *   skipReasons: string[];
 *   log: string[];
 * }}
 */
export function checkProductionDeployNeeded({
  releaseSha,
  deployedStateJson,
  packageVersions,
}) {
  const parsed = parseDeployedState(deployedStateJson);
  const deployedState = parsed === null ? {} : parsed;

  /** @type {Record<import("./update-deployed-state.mjs").DeploySurface, boolean>} */
  const surfaces = {
    api: false,
    web: false,
    marketing: false,
    admin: false,
  };

  /** @type {string[]} */
  const skipReasons = [];
  /** @type {string[]} */
  const log = [];

  for (const surface of DEPLOY_SURFACES) {
    const result = evaluateProductionSurface({
      surface,
      packageVersions,
      deployedState,
      releaseSha,
    });
    surfaces[surface] = result.needsDeploy;
    log.push(result.reason);
    if (!result.needsDeploy) {
      skipReasons.push(result.reason);
    }
  }

  const shouldDeploy = DEPLOY_SURFACES.some((surface) => surfaces[surface]);

  if (!shouldDeploy) {
    log.push("All production surfaces already deployed or gated — skipping release deploy");
  }

  return { shouldDeploy, surfaces, skipReasons, log };
}

/**
 * @param {import("./detect-deploy-targets.mjs").DeployTargets} targets
 * @param {object} input
 * @param {import("./update-deployed-state.mjs").DeployedState} input.deployedState
 * @param {Record<string, string>} input.packageVersions
 * @param {string} input.releaseSha
 * @param {string[]} [input.log]
 * @param {string[]} [input.skipReasons]
 */
export function applyAlreadyDeployedSkip(
  targets,
  { deployedState, packageVersions, releaseSha, log = [], skipReasons = [] },
) {
  for (const surface of DEPLOY_SURFACES) {
    const result = evaluateProductionSurface({
      surface,
      packageVersions,
      deployedState,
      releaseSha,
    });
    if (result.needsDeploy) {
      continue;
    }
    for (const flag of SURFACE_TARGET_FLAGS[surface]) {
      if (targets[flag]) {
        targets[flag] = false;
        skipReasons.push(result.reason);
        log.push(result.reason);
      }
    }
  }
}

/**
 * @param {Record<import("./update-deployed-state.mjs").DeploySurface, boolean>} surfaces
 * @returns {Record<string, string>}
 */
export function formatProductionDeployOutputs(surfaces) {
  return {
    should_deploy: String(
      DEPLOY_SURFACES.some((surface) => surfaces[surface]),
    ),
    deploy_api_needed: String(surfaces.api),
    deploy_web_needed: String(surfaces.web),
    deploy_marketing_needed: String(surfaces.marketing),
    deploy_admin_needed: String(surfaces.admin),
  };
}
