/**
 * Canonical public origins for deploy plan /version probes and smoke checks.
 * GHA environment vars or secrets override these defaults when set.
 */

import { appendFileSync } from "node:fs";

/** @typedef {'staging' | 'production'} DeployEnvironment */

/** @typedef {'APP_BASE_URL' | 'FRONTEND_ORIGIN' | 'MARKETING_ORIGIN' | 'ADMIN_URL'} DeployProbeOriginKey */

/**
 * @typedef {Record<DeployProbeOriginKey, string>} DeployProbeOrigins
 */

/** @type {Record<DeployEnvironment, DeployProbeOrigins>} */
export const DEPLOY_PROBE_ORIGINS = {
  staging: {
    APP_BASE_URL: "https://staging-api.slugbase.app",
    FRONTEND_ORIGIN: "https://staging-cloud.slugbase.app",
    MARKETING_ORIGIN: "https://staging.slugbase.app",
    ADMIN_URL: "https://staging-admin.slugbase.app",
  },
  production: {
    APP_BASE_URL: "https://api.slugbase.app",
    FRONTEND_ORIGIN: "https://cloud.slugbase.app",
    MARKETING_ORIGIN: "https://slugbase.app",
    ADMIN_URL: "https://admin.slugbase.app",
  },
};

/**
 * @param {DeployEnvironment} environment
 * @param {Partial<DeployProbeOrigins>} [overrides]
 * @returns {DeployProbeOrigins}
 */
export function resolveDeployProbeOrigins(environment, overrides = {}) {
  const defaults = DEPLOY_PROBE_ORIGINS[environment];
  if (!defaults) {
    throw new Error(
      `resolveDeployProbeOrigins: unknown environment "${environment}"`,
    );
  }

  return {
    APP_BASE_URL: overrides.APP_BASE_URL?.trim() || defaults.APP_BASE_URL,
    FRONTEND_ORIGIN:
      overrides.FRONTEND_ORIGIN?.trim() || defaults.FRONTEND_ORIGIN,
    MARKETING_ORIGIN:
      overrides.MARKETING_ORIGIN?.trim() || defaults.MARKETING_ORIGIN,
    ADMIN_URL: overrides.ADMIN_URL?.trim() || defaults.ADMIN_URL,
  };
}

/**
 * @param {DeployProbeOrigins} origins
 * @returns {{ api: string; web: string; marketing: string; admin: string }}
 */
export function toDeployPlanOrigins(origins) {
  return {
    api: origins.APP_BASE_URL,
    web: origins.FRONTEND_ORIGIN,
    marketing: origins.MARKETING_ORIGIN,
    admin: origins.ADMIN_URL,
  };
}

/**
 * @param {DeployProbeOrigins} origins
 */
export function writeGithubEnv(origins) {
  const githubEnv = process.env.GITHUB_ENV;
  if (!githubEnv) {
    return;
  }

  for (const [key, value] of Object.entries(origins)) {
    appendFileSync(githubEnv, `${key}=${value}\n`);
  }
}

/**
 * CLI: resolve origins for ENVIRONMENT and optionally write to GITHUB_ENV.
 */
export function main() {
  const environment = process.env.ENVIRONMENT;
  if (environment !== "staging" && environment !== "production") {
    throw new Error(
      "deploy-probe-origins: ENVIRONMENT must be staging or production",
    );
  }

  const origins = resolveDeployProbeOrigins(environment, {
    APP_BASE_URL: process.env.APP_BASE_URL,
    FRONTEND_ORIGIN: process.env.FRONTEND_ORIGIN,
    MARKETING_ORIGIN: process.env.MARKETING_ORIGIN,
    ADMIN_URL: process.env.ADMIN_URL,
  });

  for (const [key, value] of Object.entries(origins)) {
    process.stderr.write(`deploy-probe-origins: ${key}=${value}\n`);
  }

  if (process.argv.includes("--write-github-env")) {
    writeGithubEnv(origins);
  }

  return origins;
}

const isMain = process.argv[1]?.endsWith("deploy-probe-origins.mjs");
if (isMain) {
  main();
}
