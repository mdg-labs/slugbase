/**
 * Pre-push guard: deployable source changes since remote require package.json bumps.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ENFORCED_REMOTE_REFS,
  evaluatePushVersionBumps,
  parsePrePushLine,
  resolveDiffBase,
  resolveUpstreamRange,
} from "./lib/package-version-policy.mjs";

/**
 * @returns {string}
 */
function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/**
 * @param {string} repoRoot
 */
export function main(repoRoot = process.cwd()) {
  if (process.env.SKIP_DEPLOY_VERSION_BUMP_CHECK === "1") {
    return;
  }

  const stdin = readStdin().trim();
  if (stdin) {
    const lines = stdin.split("\n");
    for (const line of lines) {
      const parsed = parsePrePushLine(line);
      if (!parsed) {
        continue;
      }

      if (!ENFORCED_REMOTE_REFS.has(parsed.remoteRef)) {
        continue;
      }

      const fromSha = resolveDiffBase(repoRoot, {
        remoteSha: parsed.remoteSha,
        remoteRef: parsed.remoteRef,
      });
      const fromLabel = parsed.remoteRef.replace(/^refs\/heads\//, "origin/");
      const result = evaluatePushVersionBumps(
        repoRoot,
        fromSha,
        parsed.localSha,
        fromLabel,
      );
      if (!result.ok) {
        process.stderr.write(`${result.message}\n`);
        process.exit(1);
      }
    }
    return;
  }

  const { sha, label } = resolveUpstreamRange(repoRoot);
  const result = evaluatePushVersionBumps(repoRoot, sha, "HEAD", label);
  if (!result.ok) {
    process.stderr.write(`${result.message}\n`);
    process.exit(1);
  }
}

const isMain = process.argv[1]?.endsWith("check-push-version-bumps.mjs");
if (isMain) {
  main(join(import.meta.dirname, ".."));
}
