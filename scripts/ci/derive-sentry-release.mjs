/** @typedef {'api' | 'web'} SentryPackage */

/** @type {Record<SentryPackage, { pkgDir: string; releasePrefix: string }>} */
export const SENTRY_PACKAGE_MAP = {
  api: { pkgDir: "packages/backend", releasePrefix: "slugbase-api" },
  web: { pkgDir: "packages/web", releasePrefix: "slugbase-web" },
};

/**
 * @param {unknown} value
 * @returns {value is SentryPackage}
 */
export function isSentryPackage(value) {
  return value === "api" || value === "web";
}

/**
 * @param {string | undefined} gitSha
 * @returns {string}
 */
export function shortGitSha(gitSha) {
  const trimmed = (gitSha ?? "").trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.slice(0, 7);
}

/**
 * @param {{
 *   packageName: SentryPackage;
 *   packageVersion: string;
 *   gitSha?: string;
 * }} input
 * @returns {string}
 */
export function deriveSentryRelease({ packageName, packageVersion, gitSha }) {
  const { releasePrefix } = SENTRY_PACKAGE_MAP[packageName];
  const sha = shortGitSha(gitSha);
  if (!sha) {
    throw new Error("derive-sentry-release: git SHA is required");
  }
  return `${releasePrefix}@${packageVersion}+${sha}`;
}
