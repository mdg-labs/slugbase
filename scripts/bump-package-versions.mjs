#!/usr/bin/env node
/**
 * Interactive local helper — detect packages needing bumps and update package.json versions.
 */

import { createInterface } from "node:readline/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stdin as input, stdout as output } from "node:process";

import { incrementSemver } from "./ci/probe-version.mjs";
import {
  SHORT_NAME_TO_DIR,
  analyzeVersionGaps,
  resolveUpstreamRange,
} from "./lib/package-version-policy.mjs";

/** @typedef {"patch" | "minor" | "major" | "skip"} BumpLevel */

/**
 * @param {string[]} argv
 * @returns {{ dryRun: boolean; baseRef?: string; assignments: Array<{ shortName: string; level: BumpLevel }> }}
 */
export function parseCliArgs(argv) {
  /** @type {{ dryRun: boolean; baseRef?: string; assignments: Array<{ shortName: string; level: BumpLevel }> }} */
  const result = {
    dryRun: false,
    assignments: [],
  };

  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      result.dryRun = true;
      index += 1;
      continue;
    }
    if (arg === "--base") {
      result.baseRef = argv[index + 1];
      index += 2;
      continue;
    }
    if (arg === "--") {
      index += 1;
      break;
    }
    index += 1;
  }

  while (index < argv.length) {
    const shortName = argv[index];
    const level = argv[index + 1];
    if (!shortName || !level) {
      break;
    }
    if (level !== "patch" && level !== "minor" && level !== "major") {
      throw new Error(`Invalid bump level "${level}" for ${shortName}`);
    }
    if (!SHORT_NAME_TO_DIR[shortName]) {
      throw new Error(`Unknown package "${shortName}"`);
    }
    result.assignments.push({ shortName, level });
    index += 2;
  }

  return result;
}

/**
 * @param {string} inputLine
 * @returns {BumpLevel}
 */
export function parseBumpChoice(inputLine) {
  const trimmed = inputLine.trim();
  if (!trimmed || trimmed.toLowerCase() === "p" || trimmed.toLowerCase() === "patch") {
    return "patch";
  }
  if (trimmed === "M" || trimmed.toLowerCase() === "major") {
    return "major";
  }
  if (trimmed.toLowerCase() === "m" || trimmed.toLowerCase() === "minor") {
    return "minor";
  }
  if (trimmed.toLowerCase() === "s" || trimmed.toLowerCase() === "skip") {
    return "skip";
  }
  return "patch";
}

/**
 * @param {string} repoRoot
 * @param {string} packageDir
 * @param {string} newVersion
 */
export function writePackageVersion(repoRoot, packageDir, newVersion) {
  const manifestPath = join(repoRoot, packageDir, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.version = newVersion;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

/**
 * @param {string} repoRoot
 * @param {{ dryRun: boolean; baseRef?: string; assignments: Array<{ shortName: string; level: BumpLevel }> }} options
 */
export async function runBumpVersions(repoRoot, options) {
  const { sha, label } = resolveUpstreamRange(repoRoot, options.baseRef);
  const gaps = analyzeVersionGaps(repoRoot, sha, "HEAD");

  if (gaps.length === 0) {
    console.log(`No deployable changes since ${label}.`);
    return;
  }

  /** @type {Array<{ dir: string; name: string; from: string; to: string }>} */
  const plans = [];

  if (options.assignments.length > 0) {
    const gapByShortName = new Map(
      gaps.map((gap) => [gap.dir.replace("packages/", ""), gap]),
    );
    for (const assignment of options.assignments) {
      const gap = gapByShortName.get(assignment.shortName);
      if (!gap) {
        console.warn(`Skipping ${assignment.shortName}: no version gap detected`);
        continue;
      }
      plans.push({
        dir: gap.dir,
        name: gap.name,
        from: gap.currentVersion,
        to: incrementSemver(gap.currentVersion, assignment.level),
      });
    }
  } else {
    const rl = createInterface({ input, output });
    try {
      console.log(`Changes since ${label}:\n`);
      for (const gap of gaps) {
        const reasonText = gap.reasons.join(", ");
        console.log(`${gap.name} — ${reasonText}`);
        if (gap.sampleFiles.length > 0) {
          console.log(`  files: ${gap.sampleFiles.join(", ")}`);
        }
        console.log(`  current: ${gap.currentVersion}`);
        const answer = await rl.question(
          "  bump? [p]atch / [m]inor / [M]ajor / [s]kip [p]: ",
        );
        const level = parseBumpChoice(answer);
        if (level === "skip") {
          console.log("");
          continue;
        }
        plans.push({
          dir: gap.dir,
          name: gap.name,
          from: gap.currentVersion,
          to: incrementSemver(gap.currentVersion, level),
        });
        console.log("");
      }
    } finally {
      rl.close();
    }
  }

  if (plans.length === 0) {
    console.log("No version bumps selected.");
    return;
  }

  console.log("Proposed bumps:");
  for (const plan of plans) {
    console.log(`  ${plan.name}: ${plan.from} → ${plan.to}`);
  }

  if (options.dryRun) {
    console.log("\nDry run — no files written.");
    return;
  }

  if (options.assignments.length === 0) {
    const rl = createInterface({ input, output });
    try {
      const confirm = await rl.question("\nApply these bumps? [y/N]: ");
      if (!/^y(es)?$/i.test(confirm.trim())) {
        console.log("Aborted — no files written.");
        return;
      }
    } finally {
      rl.close();
    }
  }

  for (const plan of plans) {
    writePackageVersion(repoRoot, plan.dir, plan.to);
    console.log(`Updated ${plan.dir}/package.json`);
  }

  console.log("\nNext: git add packages/*/package.json && git commit");
}

/**
 * @param {string} [repoRoot]
 */
export async function main(repoRoot = process.cwd()) {
  const options = parseCliArgs(process.argv.slice(2));
  await runBumpVersions(repoRoot, options);
}

const isMain = process.argv[1]?.endsWith("bump-package-versions.mjs");
if (isMain) {
  main(join(import.meta.dirname, "..")).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
