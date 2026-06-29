#!/usr/bin/env node
/**
 * Discover CE-eligible service tags on a published release commit (spec §22.8).
 * Used by release.yml — no live /version probes.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CE_MIN_VERSION } from "./create-draft-release.mjs";
import { semverGte } from "./probe-version.mjs";

export const CE_SERVICE_IDS = ["api", "web"];

/** @type {RegExp} */
export const SERVICE_TAG_REGEX = /^slugbase-(api|web)\/v(\d+\.\d+\.\d+)/;

/**
 * @param {string} tag
 * @returns {{ service: string; version: string } | null}
 */
export function parseCeServiceTag(tag) {
  const match = SERVICE_TAG_REGEX.exec(tag.trim());
  if (!match) {
    return null;
  }
  return { service: match[1], version: match[2] };
}

/**
 * @param {string} repoRoot
 * @param {string} commitish
 * @returns {string}
 */
export function resolveCommitSha(repoRoot, commitish) {
  return execFileSync("git", ["rev-parse", commitish], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
}

/**
 * @param {string} repoRoot
 * @param {string} sha
 * @returns {string[]}
 */
export function listTagsPointingAt(repoRoot, sha) {
  try {
    const output = execFileSync("git", ["tag", "--points-at", sha], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    if (!output) {
      return [];
    }
    return output.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * @typedef {object} ReleaseServiceTagPlan
 * @property {boolean} push_ghcr_api
 * @property {boolean} push_ghcr_web
 * @property {string[]} skipped_below_floor
 * @property {string | null} api_tag
 * @property {string | null} web_tag
 */

/**
 * @param {string[]} tags
 * @returns {ReleaseServiceTagPlan}
 */
export function listReleaseServiceTags(tags) {
  /** @type {ReleaseServiceTagPlan} */
  const result = {
    push_ghcr_api: false,
    push_ghcr_web: false,
    skipped_below_floor: [],
    api_tag: null,
    web_tag: null,
  };

  for (const tag of tags) {
    const parsed = parseCeServiceTag(tag);
    if (!parsed) {
      continue;
    }
    if (!semverGte(parsed.version, CE_MIN_VERSION)) {
      result.skipped_below_floor.push(tag);
      continue;
    }
    if (parsed.service === "api") {
      result.push_ghcr_api = true;
      result.api_tag = tag;
    }
    if (parsed.service === "web") {
      result.push_ghcr_web = true;
      result.web_tag = tag;
    }
  }

  return result;
}

/**
 * @param {ReleaseServiceTagPlan} plan
 * @param {string} releaseTag
 */
export function writeReleaseGithubOutput(plan, releaseTag) {
  const githubOutput = process.env.GITHUB_OUTPUT;
  const lines = [
    `push_ghcr_api=${plan.push_ghcr_api}`,
    `push_ghcr_web=${plan.push_ghcr_web}`,
    `release_tag=${releaseTag}`,
  ];
  if (plan.skipped_below_floor.length > 0) {
    lines.push(`skipped_below_floor=${plan.skipped_below_floor.join(",")}`);
  }
  if (!githubOutput) {
    for (const line of lines) {
      process.stdout.write(`${line}\n`);
    }
    return;
  }
  for (const line of lines) {
    appendFileSync(githubOutput, `${line}\n`);
  }
}

/**
 * @param {{
 *   repoRoot?: string;
 *   commitish?: string;
 *   releaseTag?: string;
 *   resolveSha?: (repoRoot: string, commitish: string) => string;
 *   listTags?: (repoRoot: string, sha: string) => string[];
 *   log?: (message: string) => void;
 * }} [options]
 */
export function discoverReleaseServiceTags(options = {}) {
  const {
    repoRoot = process.cwd(),
    commitish = process.env.COMMIT_SHA ?? "HEAD",
    releaseTag = process.env.RELEASE_TAG ?? "",
    resolveSha = (root, ref) => resolveCommitSha(root, ref),
    listTags = (root, sha) => listTagsPointingAt(root, sha),
    log = (message) => {
      process.stderr.write(`${message}\n`);
    },
  } = options;

  const sha = resolveSha(repoRoot, commitish);
  const tags = listTags(repoRoot, sha);
  const plan = listReleaseServiceTags(tags);

  if (plan.skipped_below_floor.length > 0) {
    log(
      `Skipping CE :latest for tags below ${CE_MIN_VERSION}: ${plan.skipped_below_floor.join(", ")}`,
    );
  }
  if (plan.push_ghcr_api) {
    log(`CE api push enabled via ${plan.api_tag}`);
  }
  if (plan.push_ghcr_web) {
    log(`CE web push enabled via ${plan.web_tag}`);
  }
  if (!plan.push_ghcr_api && !plan.push_ghcr_web) {
    log("No CE-eligible service tags on release commit — skipping GHCR jobs");
  }

  writeReleaseGithubOutput(plan, releaseTag);
  return plan;
}

const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  discoverReleaseServiceTags();
}
