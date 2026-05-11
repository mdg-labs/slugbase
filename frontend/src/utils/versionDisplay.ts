/**
 * Normalize labels from GET /api/version (`version` from root package.json, `commit` from COMMIT_SHA).
 * Prefer semver for user-visible text; use a short SHA only when version is missing.
 */

const GIT_SHA_HEX = /^[a-f0-9]{7,40}$/i;

function shortenIfFullSha(label: string): string {
  return GIT_SHA_HEX.test(label) ? label.slice(0, 7) : label;
}

/** Mono line in sidebar / auth header: package version, else first 7 hex chars of commit. */
export function shortDisplayLabel(
  apiVersion?: string | null,
  apiCommit?: string | null,
): string | null {
  const ver = typeof apiVersion === 'string' ? apiVersion.trim() : '';
  if (ver.length > 0) return shortenIfFullSha(ver);
  const commit = typeof apiCommit === 'string' ? apiCommit.trim() : '';
  if (commit.length > 0) return commit.slice(0, 7);
  return null;
}

/**
 * Raw release string for hero stat formatting (semver as-is, or full commit before `formatVersionForStat`).
 */
export function primaryVersionOrCommit(
  apiVersion?: string | null,
  apiCommit?: string | null,
): string | null {
  const ver = typeof apiVersion === 'string' ? apiVersion.trim() : '';
  if (ver.length > 0) return ver;
  const commit = typeof apiCommit === 'string' ? apiCommit.trim() : '';
  if (commit.length > 0) return commit;
  return null;
}

/** Optional tooltip: "semver · shortSha" when both exist; full SHA when display is shortened. */
export function versionDisplayTitle(
  apiVersion?: string | null,
  apiCommit?: string | null,
): string | undefined {
  const ver = typeof apiVersion === 'string' ? apiVersion.trim() : '';
  const commit = typeof apiCommit === 'string' ? apiCommit.trim() : '';
  if (ver.length > 0 && commit.length > 0)
    return `${shortenIfFullSha(ver)} · ${commit.slice(0, 7)}`;
  if (commit.length > 7) return commit;
  if (ver.length > 0) return shortenIfFullSha(ver);
  return undefined;
}
