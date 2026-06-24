/**
 * Merge successful deploy surfaces into DEPLOYED_STATE (granular-deployment WP-2).
 * Consumed by `.github/scripts/update-deployed-state.sh` and unit tests.
 */

/** @typedef {{ version: string; sha: string }} SurfaceState */

/** @typedef {Record<string, SurfaceState>} DeployedState */

/** @typedef {'api' | 'web' | 'marketing' | 'admin'} DeploySurface */

export const DEPLOY_SURFACES = /** @type {const} */ ([
  "api",
  "web",
  "marketing",
  "admin",
]);

/** @type {Record<DeploySurface, { package: string; dir: string }>} */
export const SURFACE_PACKAGES = {
  api: { package: "@slugbase/backend", dir: "packages/backend" },
  web: { package: "@slugbase/web", dir: "packages/web" },
  marketing: { package: "@slugbase/marketing", dir: "packages/marketing" },
  admin: { package: "@slugbase/admin", dir: "packages/admin" },
};

/**
 * @param {string | undefined | null} raw
 * @returns {DeployedState | null}
 */
export function parseDeployedState(raw) {
  if (!raw || typeof raw !== "string" || !raw.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return /** @type {DeployedState} */ (parsed);
  } catch {
    return null;
  }
}

/**
 * @param {string | undefined | null} raw
 * @returns {boolean}
 */
export function isValidDeployedStateJson(raw) {
  return parseDeployedState(raw) !== null;
}

/**
 * @param {DeployedState | string | null | undefined} current
 * @param {DeployedState} updates
 * @returns {string}
 */
export function mergeDeployedState(current, updates) {
  const base =
    typeof current === "string"
      ? parseDeployedState(current)
      : current === null || current === undefined
        ? {}
        : current;
  const state = base === null ? {} : { ...base };
  for (const [key, value] of Object.entries(updates)) {
    state[key] = value;
  }
  return `${JSON.stringify(state, null, 2)}\n`;
}

/**
 * @param {object} input
 * @param {Record<DeploySurface, string>} input.deployFlags
 * @param {Record<DeploySurface, string>} input.deployResults
 * @returns {DeploySurface[]}
 */
export function surfacesToUpdate({ deployFlags, deployResults }) {
  return DEPLOY_SURFACES.filter((surface) => {
    const flag = deployFlags[surface];
    const result = deployResults[surface];
    return flag === "true" && result === "success";
  });
}

/**
 * @param {object} input
 * @param {string} input.sha
 * @param {DeploySurface[]} input.surfaces
 * @param {Record<string, string>} input.packageVersions
 * @returns {DeployedState}
 */
export function buildSurfaceUpdates({ sha, surfaces, packageVersions }) {
  /** @type {DeployedState} */
  const updates = {};
  for (const surface of surfaces) {
    const mapping = SURFACE_PACKAGES[surface];
    const version = packageVersions[mapping.package];
    if (!version) {
      continue;
    }
    updates[surface] = { version, sha };
  }
  return updates;
}

/**
 * @param {string} environment
 * @returns {string}
 */
export function deployedStateVariableName(environment) {
  if (environment !== "staging" && environment !== "production") {
    throw new Error(
      `deployedStateVariableName: environment must be staging or production, got: ${environment}`,
    );
  }
  return `DEPLOYED_STATE_${environment}`;
}
