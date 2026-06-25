/**
 * Deploy package version policy — shared by pre-push gate and bump:versions CLI.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { incrementSemver, semverGt } from "../ci/probe-version.mjs";

export { incrementSemver };

/** @typedef {keyof typeof SHARED_LIB_CONSUMERS} SharedLibDir */

/** Shared workspace libs (stay at 0.0.0) → deployable consumers. */
export const SHARED_LIB_CONSUMERS = {
  "packages/shared-types": [
    "packages/backend",
    "packages/web",
    "packages/marketing",
    "packages/admin",
  ],
  "packages/ui": ["packages/web", "packages/marketing"],
  "packages/email-templates": ["packages/backend"],
  "packages/db-admin": ["packages/admin"],
};

/** Deployable surfaces probed at /version. */
export const DEPLOYABLE_DIRS = [
  "packages/backend",
  "packages/web",
  "packages/marketing",
  "packages/admin",
];

/** @type {Record<string, string>} */
export const PACKAGE_DIR_TO_NAME = {
  "packages/backend": "@slugbase/backend",
  "packages/web": "@slugbase/web",
  "packages/marketing": "@slugbase/marketing",
  "packages/admin": "@slugbase/admin",
};

/** @type {Record<string, string>} */
export const SHORT_NAME_TO_DIR = {
  backend: "packages/backend",
  web: "packages/web",
  marketing: "packages/marketing",
  admin: "packages/admin",
};

export const ZERO_SHA = "0".repeat(40);

export const ENFORCED_REMOTE_REFS = new Set(["refs/heads/staging", "refs/heads/main"]);

const IGNORE_SUFFIXES = [
  "/README.md",
  "/CHANGELOG.md",
  ".md",
  ".spec.ts",
  ".spec.tsx",
  "vitest.config.ts",
  "vitest.integration.config.ts",
];

/**
 * @typedef {object} VersionGap
 * @property {string} dir
 * @property {string} name
 * @property {string[]} reasons
 * @property {string} currentVersion
 * @property {string} remoteVersion
 * @property {string[]} sampleFiles
 */

/**
 * @param {string} relativePath
 * @returns {boolean}
 */
export function isIgnoredPath(relativePath) {
  if (!relativePath.startsWith("packages/")) {
    return true;
  }
  if (relativePath.endsWith("/package.json")) {
    return true;
  }
  return IGNORE_SUFFIXES.some((suffix) => relativePath.endsWith(suffix));
}

/**
 * @param {string[]} paths
 * @param {string} prefix
 * @returns {string[]}
 */
export function findRelevantPathsUnderPrefix(paths, prefix) {
  const normalized = prefix.endsWith("/") ? prefix : `${prefix}/`;
  return paths.filter(
    (path) => path.startsWith(normalized) && !isIgnoredPath(path),
  );
}

/**
 * @param {string[]} paths
 * @returns {SharedLibDir[]}
 */
export function findAffectedSharedLibs(paths) {
  /** @type {Set<SharedLibDir>} */
  const affected = new Set();
  for (const changedPath of paths) {
    for (const sharedDir of Object.keys(SHARED_LIB_CONSUMERS)) {
      if (!changedPath.startsWith(`${sharedDir}/`)) {
        continue;
      }
      if (isIgnoredPath(changedPath)) {
        continue;
      }
      affected.add(/** @type {SharedLibDir} */ (sharedDir));
    }
  }
  return [...affected];
}

/**
 * @param {SharedLibDir[]} affectedSharedLibs
 * @returns {string[]}
 */
export function deriveRequiredConsumers(affectedSharedLibs) {
  /** @type {Set<string>} */
  const consumers = new Set();
  for (const sharedDir of affectedSharedLibs) {
    for (const consumer of SHARED_LIB_CONSUMERS[sharedDir]) {
      consumers.add(consumer);
    }
  }
  return [...consumers].sort();
}

/**
 * @param {string | undefined} raw
 * @returns {string}
 */
export function readPackageVersionFromJson(raw) {
  if (!raw?.trim()) {
    return "0.0.0";
  }
  const manifest = JSON.parse(raw);
  return typeof manifest.version === "string" ? manifest.version : "0.0.0";
}

/**
 * @param {string} repoRoot
 * @param {string[]} gitArgs
 * @returns {string | undefined}
 */
export function gitExec(repoRoot, gitArgs) {
  try {
    return execFileSync("git", gitArgs, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return undefined;
  }
}

/**
 * @param {string} sha
 * @returns {boolean}
 */
export function isZeroSha(sha) {
  return sha === ZERO_SHA;
}

/**
 * @param {string} repoRoot
 * @param {string} fromSha
 * @param {string} toSha
 * @returns {string[]}
 */
export function listChangedPaths(repoRoot, fromSha, toSha) {
  const output = gitExec(repoRoot, [
    "diff",
    "--name-only",
    fromSha,
    toSha,
    "--diff-filter=ACMR",
  ]);
  if (!output) {
    return [];
  }
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * @param {string} repoRoot
 * @param {string} sha
 * @param {string} packageDir
 * @returns {string}
 */
export function readPackageVersionAtSha(repoRoot, sha, packageDir) {
  const manifestPath = `${packageDir}/package.json`;
  if (sha === "HEAD") {
    try {
      const workingTree = readFileSync(join(repoRoot, manifestPath), "utf8");
      return readPackageVersionFromJson(workingTree);
    } catch {
      // fall through to git show
    }
  }
  const resolvedSha = sha === "HEAD" ? "HEAD" : sha;
  const raw = gitExec(repoRoot, ["show", `${resolvedSha}:${manifestPath}`]);
  return readPackageVersionFromJson(raw);
}

/**
 * @param {string} repoRoot
 * @param {{ remoteSha: string; remoteRef?: string }} input
 * @returns {string}
 */
export function resolveDiffBase(repoRoot, input) {
  if (!isZeroSha(input.remoteSha)) {
    return input.remoteSha;
  }

  const branch = input.remoteRef?.replace(/^refs\/heads\//, "") ?? "";
  if (branch) {
    const mergeBase = gitExec(repoRoot, ["merge-base", "HEAD", `origin/${branch}`]);
    if (mergeBase?.trim()) {
      return mergeBase.trim();
    }
  }

  const root = gitExec(repoRoot, ["rev-list", "--max-parents=0", "HEAD"]);
  return root?.trim() ?? ZERO_SHA;
}

/**
 * @param {string} repoRoot
 * @param {string} [baseRef]
 * @returns {{ sha: string; label: string }}
 */
export function resolveUpstreamRange(repoRoot, baseRef) {
  if (baseRef) {
    const sha = gitExec(repoRoot, ["rev-parse", baseRef])?.trim();
    if (!sha) {
      throw new Error(`Could not resolve git ref: ${baseRef}`);
    }
    return { sha, label: baseRef };
  }

  const upstream = gitExec(repoRoot, ["rev-parse", "@{upstream}"])?.trim();
  if (upstream) {
    const upstreamName =
      gitExec(repoRoot, ["rev-parse", "--abbrev-ref", "@{upstream}"])?.trim() ??
      "@{upstream}";
    return { sha: upstream, label: upstreamName };
  }

  const branch =
    gitExec(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"])?.trim() ?? "HEAD";
  const originBranch = gitExec(repoRoot, ["rev-parse", `origin/${branch}`])?.trim();
  if (originBranch) {
    return { sha: originBranch, label: `origin/${branch}` };
  }

  throw new Error(
    "No upstream configured. Use --base origin/staging or set branch upstream.",
  );
}

/**
 * @param {string} repoRoot
 * @param {string} fromSha
 * @param {string} toSha
 * @returns {VersionGap[]}
 */
export function analyzeVersionGaps(repoRoot, fromSha, toSha) {
  const paths = listChangedPaths(repoRoot, fromSha, toSha);

  /** @type {Map<string, VersionGap>} */
  const gaps = new Map();

  for (const deployDir of DEPLOYABLE_DIRS) {
    const relevant = findRelevantPathsUnderPrefix(paths, deployDir);
    if (relevant.length === 0) {
      continue;
    }

    const remoteVersion = readPackageVersionAtSha(repoRoot, fromSha, deployDir);
    const currentVersion = readPackageVersionAtSha(repoRoot, toSha, deployDir);

    if (!semverGt(currentVersion, remoteVersion)) {
      gaps.set(deployDir, {
        dir: deployDir,
        name: PACKAGE_DIR_TO_NAME[deployDir] ?? deployDir,
        reasons: ["direct"],
        currentVersion,
        remoteVersion,
        sampleFiles: relevant.slice(0, 3),
      });
    }
  }

  const affectedShared = findAffectedSharedLibs(paths);
  for (const consumerDir of deriveRequiredConsumers(affectedShared)) {
    const remoteVersion = readPackageVersionAtSha(repoRoot, fromSha, consumerDir);
    const currentVersion = readPackageVersionAtSha(repoRoot, toSha, consumerDir);

    if (semverGt(currentVersion, remoteVersion)) {
      continue;
    }

    const sharedReasons = affectedShared
      .filter((sharedDir) => SHARED_LIB_CONSUMERS[sharedDir].includes(consumerDir))
      .map((sharedDir) => `via ${sharedDir.replace("packages/", "")}`);

    const sampleFiles = affectedShared
      .flatMap((sharedDir) => findRelevantPathsUnderPrefix(paths, sharedDir))
      .slice(0, 3);

    const existing = gaps.get(consumerDir);
    if (existing) {
      existing.reasons = [...new Set([...existing.reasons, ...sharedReasons])];
      if (existing.sampleFiles.length === 0) {
        existing.sampleFiles = sampleFiles;
      }
      continue;
    }

    gaps.set(consumerDir, {
      dir: consumerDir,
      name: PACKAGE_DIR_TO_NAME[consumerDir] ?? consumerDir,
      reasons: sharedReasons,
      currentVersion,
      remoteVersion,
      sampleFiles,
    });
  }

  return [...gaps.values()].sort((left, right) => left.dir.localeCompare(right.dir));
}

/**
 * @param {string} fromLabel
 * @param {VersionGap[]} gaps
 * @returns {string}
 */
export function formatFailureMessage(fromLabel, gaps) {
  const affectedLines = gaps.map((gap) => {
    const reasonText = gap.reasons.join(", ");
    const sample =
      gap.sampleFiles.length > 0 ? ` (${gap.sampleFiles[0]})` : "";
    return `  - ${gap.name} (${reasonText}${sample})`;
  });

  return [
    "check-push-version-bumps: FAIL",
    "",
    `Deployable changes since ${fromLabel} require a package.json version bump.`,
    "",
    "Affected:",
    ...affectedLines,
    "",
    "Fix:",
    "  pnpm bump:versions",
    "",
    "Then commit the updated package.json files and push again.",
    "",
    "Dry-run:  pnpm bump:versions --dry-run",
    "Manual:   pnpm check:push-version-bumps",
    "Skip once: SKIP_DEPLOY_VERSION_BUMP_CHECK=1 git push --no-verify",
  ].join("\n");
}

/**
 * @param {string} repoRoot
 * @param {string} fromSha
 * @param {string} toSha
 * @param {string} fromLabel
 * @returns {{ ok: true } | { ok: false; message: string }}
 */
export function evaluatePushVersionBumps(repoRoot, fromSha, toSha, fromLabel) {
  const gaps = analyzeVersionGaps(repoRoot, fromSha, toSha);
  if (gaps.length === 0) {
    return { ok: true };
  }
  return { ok: false, message: formatFailureMessage(fromLabel, gaps) };
}

/**
 * @param {string} line
 * @returns {{ localRef: string; localSha: string; remoteRef: string; remoteSha: string } | null}
 */
export function parsePrePushLine(line) {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 4) {
    return null;
  }
  const [localRef, localSha, remoteRef, remoteSha] = parts;
  if (!localRef || !localSha || !remoteRef || !remoteSha) {
    return null;
  }
  return { localRef, localSha, remoteRef, remoteSha };
}
