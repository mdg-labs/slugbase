/**
 * Turbo-based deploy target detection (granular-deployment WP-1).
 * Consumed by `.github/scripts/detect-deploy-targets.sh` and unit tests.
 */

/** @typedef {'staging' | 'production'} DeployEnvironment */

/**
 * @typedef {object} DeployTargets
 * @property {boolean} deploy_api
 * @property {boolean} deploy_web
 * @property {boolean} deploy_marketing
 * @property {boolean} deploy_admin
 * @property {boolean} run_migrate
 * @property {boolean} run_migrate_admin
 * @property {boolean} push_ghcr_api
 * @property {boolean} push_ghcr_web
 * @property {string} sync_services
 */

/**
 * @typedef {object} DetectDeployTargetsInput
 * @property {DeployEnvironment} environment
 * @property {string[]} affectedPackages
 * @property {string[]} changedPaths
 * @property {Record<string, string>} packageVersions
 * @property {boolean} forceFullDeploy
 */

/**
 * @typedef {object} DetectDeployTargetsResult
 * @property {DeployTargets} targets
 * @property {string[]} skipReasons
 * @property {string[]} log
 */

/** @type {DeployTargets} */
export const ALL_DEPLOY_TARGETS = {
  deploy_api: true,
  deploy_web: true,
  deploy_marketing: true,
  deploy_admin: true,
  run_migrate: true,
  run_migrate_admin: true,
  push_ghcr_api: true,
  push_ghcr_web: true,
  sync_services: "api,web,marketing,admin",
};

/** @type {Record<string, Partial<Omit<DeployTargets, "sync_services">>>} */
const PACKAGE_TARGET_MAP = {
  "@slugbase/backend": {
    deploy_api: true,
    push_ghcr_api: true,
    run_migrate: true,
  },
  "@slugbase/web": {
    deploy_web: true,
    push_ghcr_web: true,
  },
  "@slugbase/marketing": {
    deploy_marketing: true,
  },
  "@slugbase/admin": {
    deploy_admin: true,
  },
  "@slugbase/db-admin": {
    deploy_admin: true,
    run_migrate_admin: true,
  },
  "@slugbase/shared-types": {
    deploy_api: true,
    deploy_web: true,
    deploy_marketing: true,
    push_ghcr_api: true,
    push_ghcr_web: true,
  },
  "@slugbase/ui": {
    deploy_web: true,
    deploy_marketing: true,
    push_ghcr_web: true,
  },
  "@slugbase/email-templates": {
    deploy_api: true,
    push_ghcr_api: true,
  },
};

/** @type {Array<{ test: (path: string) => boolean; targets: Partial<Omit<DeployTargets, "sync_services">> }>} */
const PATH_RULES = [
  {
    test: (path) =>
      path.startsWith("packages/backend/migrations/") ||
      path.startsWith("packages/backend/drizzle/"),
    targets: {
      deploy_api: true,
      push_ghcr_api: true,
      run_migrate: true,
    },
  },
  {
    test: (path) => path.startsWith("packages/db-admin/migrations/"),
    targets: {
      deploy_admin: true,
      run_migrate_admin: true,
    },
  },
  {
    test: (path) =>
      path === "Dockerfile.api" ||
      path === "fly.toml" ||
      /^\.github\/scripts\/(deploy-fly|fly-deploy)/.test(path),
    targets: {
      deploy_api: true,
      push_ghcr_api: true,
    },
  },
  {
    test: (path) =>
      path === "Dockerfile.web" ||
      /^\.github\/scripts\/(deploy-cf-worker|wrangler-deploy)/.test(path),
    targets: {
      deploy_web: true,
      push_ghcr_web: true,
    },
  },
  {
    test: (path) =>
      path === "pnpm-lock.yaml" ||
      path === "turbo.json" ||
      path === ".nvmrc" ||
      path === "package.json" ||
      path.startsWith(".github/workflows/"),
    targets: {
      deploy_api: true,
      deploy_web: true,
      deploy_marketing: true,
      deploy_admin: true,
      run_migrate: true,
      run_migrate_admin: true,
      push_ghcr_api: true,
      push_ghcr_web: true,
    },
  },
];

/** @type {Record<keyof Omit<DeployTargets, "sync_services">, string>} */
const PRODUCTION_GATE_PACKAGES = {
  deploy_api: "@slugbase/backend",
  deploy_web: "@slugbase/web",
  deploy_marketing: "@slugbase/marketing",
  deploy_admin: "@slugbase/admin",
  push_ghcr_api: "@slugbase/backend",
  push_ghcr_web: "@slugbase/web",
};

const PRODUCTION_MIN_VERSION = "1.0.0";

/**
 * @returns {DeployTargets}
 */
export function createEmptyDeployTargets() {
  return {
    deploy_api: false,
    deploy_web: false,
    deploy_marketing: false,
    deploy_admin: false,
    run_migrate: false,
    run_migrate_admin: false,
    push_ghcr_api: false,
    push_ghcr_web: false,
    sync_services: "",
  };
}

/**
 * @param {string} version
 * @returns {[number, number, number] | null}
 */
function parseSemver(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * @param {string} left
 * @param {string} right
 * @returns {boolean}
 */
export function semverLt(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) {
    return false;
  }
  for (let i = 0; i < 3; i += 1) {
    if (a[i] < b[i]) {
      return true;
    }
    if (a[i] > b[i]) {
      return false;
    }
  }
  return false;
}

/**
 * @param {DeployTargets} targets
 * @param {Partial<Omit<DeployTargets, "sync_services">>} patch
 */
function mergeTargets(targets, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value) {
      targets[key] = true;
    }
  }
}

/**
 * @param {DeployTargets} targets
 * @returns {string}
 */
export function deriveSyncServices(targets) {
  /** @type {string[]} */
  const services = [];
  if (targets.deploy_api) {
    services.push("api");
  }
  if (targets.deploy_web) {
    services.push("web");
  }
  if (targets.deploy_marketing) {
    services.push("marketing");
  }
  if (targets.deploy_admin) {
    services.push("admin");
  }
  return services.join(",");
}

/**
 * @param {unknown} turboDryRun
 * @returns {string[]}
 */
export function extractAffectedPackages(turboDryRun) {
  if (!turboDryRun || typeof turboDryRun !== "object") {
    return [];
  }
  const packages = /** @type {{ packages?: unknown }} */ (turboDryRun).packages;
  if (!Array.isArray(packages)) {
    return [];
  }
  return packages.filter((pkg) => typeof pkg === "string");
}

/**
 * @param {DetectDeployTargetsInput} input
 * @returns {DetectDeployTargetsResult}
 */
export function detectDeployTargets(input) {
  /** @type {string[]} */
  const log = [];

  if (input.forceFullDeploy) {
    log.push("force_full_deploy=true — deploying all surfaces");
    return {
      targets: { ...ALL_DEPLOY_TARGETS },
      skipReasons: [],
      log,
    };
  }

  const targets = createEmptyDeployTargets();

  for (const pkg of input.affectedPackages) {
    if (pkg === "//") {
      log.push("turbo affected root package — deploying all surfaces");
      mergeTargets(targets, ALL_DEPLOY_TARGETS);
      continue;
    }
    const mapped = PACKAGE_TARGET_MAP[pkg];
    if (mapped) {
      log.push(`turbo affected ${pkg}`);
      mergeTargets(targets, mapped);
    }
  }

  for (const path of input.changedPaths) {
    for (const rule of PATH_RULES) {
      if (rule.test(path)) {
        log.push(`changed path ${path}`);
        mergeTargets(targets, rule.targets);
      }
    }
  }

  const skipReasons = applyProductionVersionGate(
    targets,
    input.environment,
    input.packageVersions,
    log,
  );

  targets.sync_services = deriveSyncServices(targets);
  return { targets, skipReasons, log };
}

/**
 * @param {DeployTargets} targets
 * @param {DeployEnvironment} environment
 * @param {Record<string, string>} packageVersions
 * @param {string[]} log
 * @returns {string[]}
 */
export function applyProductionVersionGate(
  targets,
  environment,
  packageVersions,
  log = [],
) {
  if (environment !== "production") {
    return [];
  }

  /** @type {string[]} */
  const skipReasons = [];

  for (const [flag, pkg] of Object.entries(PRODUCTION_GATE_PACKAGES)) {
    if (!targets[flag]) {
      continue;
    }
    const version = packageVersions[pkg] ?? "0.0.0";
    if (semverLt(version, PRODUCTION_MIN_VERSION)) {
      targets[flag] = false;
      const reason = `${flag}: skipped — ${pkg}@${version} < ${PRODUCTION_MIN_VERSION} (production gate)`;
      skipReasons.push(reason);
      log.push(reason);
    }
  }

  return skipReasons;
}

/**
 * @param {DeployTargets} targets
 * @returns {Record<string, string>}
 */
export function formatGithubOutputs(targets) {
  return {
    deploy_api: String(targets.deploy_api),
    deploy_web: String(targets.deploy_web),
    deploy_marketing: String(targets.deploy_marketing),
    deploy_admin: String(targets.deploy_admin),
    run_migrate: String(targets.run_migrate),
    run_migrate_admin: String(targets.run_migrate_admin),
    push_ghcr_api: String(targets.push_ghcr_api),
    push_ghcr_web: String(targets.push_ghcr_web),
    sync_services: targets.sync_services || "none",
  };
}
