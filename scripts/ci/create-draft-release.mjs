#!/usr/bin/env node
/**
 * Create a bump-scoped draft GitHub Release after CI on main (spec §22.6).
 * Compares deployable package.json versions since the last release-* tag.
 */
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { semverGt, semverGte } from "./probe-version.mjs";
import {
  DEPLOYABLE_DIRS,
  gitExec,
  readPackageVersionAtSha,
} from "../lib/package-version-policy.mjs";
import { SURFACES } from "./resolve-deploy-plan.mjs";

export const CE_MIN_VERSION = "1.0.0";

/** @type {Record<string, string>} */
export const SURFACE_LABELS = {
  api: "API",
  web: "Web",
  marketing: "Marketing",
  admin: "Admin",
};

/**
 * @returns {string | null}
 */
export function findLastReleaseTag() {
  try {
    const output = execFileSync(
      "git",
      ["tag", "--list", "release-*", "--sort=-creatordate"],
      { encoding: "utf8" },
    ).trim();
    if (!output) {
      return null;
    }
    return output.split("\n")[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * @param {string} repoRoot
 * @param {string} tag
 * @returns {string | null}
 */
export function resolveTagSha(repoRoot, tag) {
  const output = gitExec(repoRoot, ["rev-list", "-n", "1", tag]);
  return output?.trim() ?? null;
}

/**
 * @typedef {object} BumpedSurface
 * @property {string} id
 * @property {string} pkgDir
 * @property {string} version
 */

/**
 * @param {string} repoRoot
 * @param {string} [headSha]
 * @param {() => string | null} [findLastTag]
 * @returns {{ bumped: BumpedSurface[]; lastTag: string | null; baseSha: string | null }}
 */
export function detectBumpedSurfaces(
  repoRoot,
  headSha = "HEAD",
  findLastTag = findLastReleaseTag,
) {
  const lastTag = findLastTag();
  const baseSha = lastTag ? resolveTagSha(repoRoot, lastTag) : null;

  /** @type {BumpedSurface[]} */
  const bumped = [];

  for (const surface of SURFACES) {
    const currentVersion = readPackageVersionAtSha(repoRoot, headSha, surface.pkgDir);
    const previousVersion = baseSha
      ? readPackageVersionAtSha(repoRoot, baseSha, surface.pkgDir)
      : "0.0.0";

    if (semverGt(currentVersion, previousVersion)) {
      bumped.push({
        id: surface.id,
        pkgDir: surface.pkgDir,
        version: currentVersion,
      });
    }
  }

  return { bumped, lastTag, baseSha };
}

/**
 * @param {BumpedSurface[]} bumped
 * @returns {boolean}
 */
export function shouldSkipDraftRelease(bumped) {
  return bumped.length === 0;
}

/**
 * @param {BumpedSurface[]} bumped
 * @returns {string}
 */
export function buildReleaseTitle(bumped) {
  const parts = bumped.map(
    (surface) => `${SURFACE_LABELS[surface.id] ?? surface.id} ${surface.version}`,
  );
  return `SlugBase ${parts.join(" · ")}`;
}

/**
 * @param {string | null} lastTag
 * @param {string} gitLogBody
 * @param {string} title
 * @returns {string}
 */
export function buildReleaseNotesBody(lastTag, gitLogBody, title) {
  const trimmed = gitLogBody.trim();
  if (trimmed.length > 0) {
    return `## Changes since ${lastTag ?? "initial release"}\n\n${trimmed}`;
  }
  return `Packages: ${title}`;
}

/**
 * @param {string} dateIsoDay
 * @param {(tag: string) => boolean} tagExists
 * @returns {string}
 */
export function nextReleaseTagName(dateIsoDay, tagExists) {
  let tag = `release-${dateIsoDay}`;
  let suffix = 1;
  while (tagExists(tag)) {
    suffix += 1;
    tag = `release-${dateIsoDay}-${suffix}`;
  }
  return tag;
}

/**
 * @param {BumpedSurface[]} bumped
 * @returns {string[]}
 */
export function buildServiceTags(bumped) {
  return bumped
    .filter((surface) => semverGte(surface.version, CE_MIN_VERSION))
    .map((surface) => `slugbase-${surface.id}/v${surface.version}`);
}

/**
 * @param {string} repoRoot
 * @param {string | null} lastTag
 * @param {string[]} bumpedDirs
 * @returns {string}
 */
export function gitLogForBumpedSurfaces(repoRoot, lastTag, bumpedDirs) {
  if (bumpedDirs.length === 0) {
    return "";
  }
  const logRange = lastTag ? `${lastTag}..HEAD` : "HEAD";
  return execFileSync(
    "git",
    [
      "log",
      logRange,
      "--pretty=format:- %s (%h)",
      "--no-merges",
      "--",
      ...bumpedDirs,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  ).trim();
}

/**
 * @param {string} tag
 */
export function tagExistsLocally(tag) {
  try {
    execSync(`git rev-parse ${shellQuote(`refs/tags/${tag}`)}`, {
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} value
 */
export function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * @param {{
 *   repoRoot?: string;
 *   date?: Date;
 *   tagExists?: (tag: string) => boolean;
 *   findLastTag?: () => string | null;
 *   detectBumps?: () => ReturnType<typeof detectBumpedSurfaces>;
 *   gitLog?: (lastTag: string | null, bumpedDirs: string[]) => string;
 *   execTag?: (tag: string, title: string) => void;
 *   execPushTags?: (tags: string[]) => void;
 *   execGhRelease?: (tag: string, title: string, notesBody: string) => void;
 *   log?: (message: string) => void;
 * }} options
 */
export function createDraftRelease(options = {}) {
  const {
    repoRoot = process.cwd(),
    date = new Date(),
    tagExists = tagExistsLocally,
    findLastTag = findLastReleaseTag,
    detectBumps = () => detectBumpedSurfaces(repoRoot, "HEAD", findLastTag),
    gitLog = (lastTag, bumpedDirs) =>
      gitLogForBumpedSurfaces(repoRoot, lastTag, bumpedDirs),
    execTag = (tag, title) => {
      execSync(`git tag -a ${shellQuote(tag)} -m ${shellQuote(title)}`, {
        stdio: "inherit",
      });
    },
    execPushTags = (tags) => {
      if (tags.length === 0) {
        return;
      }
      execSync(`git push origin ${tags.map(shellQuote).join(" ")}`, {
        stdio: "inherit",
      });
    },
    execGhRelease = (tag, title, notesBody) => {
      const notesFile = path.join(repoRoot, ".draft-release-notes.md");
      fs.writeFileSync(notesFile, notesBody);
      try {
        execFileSync(
          "gh",
          [
            "release",
            "create",
            tag,
            "--title",
            title,
            "--draft",
            "--notes-file",
            notesFile,
          ],
          { stdio: "inherit", env: process.env },
        );
      } finally {
        fs.rmSync(notesFile, { force: true });
      }
    },
    log = (message) => {
      process.stdout.write(`${message}\n`);
    },
  } = options;

  const { bumped, lastTag } = detectBumps();

  if (shouldSkipDraftRelease(bumped)) {
    log("No deployable package version bumps since last release — skipping draft release");
    return { skipped: true, bumped: [] };
  }

  const title = buildReleaseTitle(bumped);
  const bumpedDirs = bumped.map((surface) => surface.pkgDir);
  const notesBody = buildReleaseNotesBody(lastTag, gitLog(lastTag, bumpedDirs), title);
  const dateIsoDay = date.toISOString().slice(0, 10);
  const releaseTag = nextReleaseTagName(dateIsoDay, tagExists);
  const serviceTags = buildServiceTags(bumped);
  const allTags = [releaseTag, ...serviceTags];

  for (const tag of allTags) {
    execTag(tag, title);
  }
  execPushTags(allTags);
  execGhRelease(releaseTag, title, notesBody);
  log(`Created draft release ${releaseTag}: ${title}`);
  if (serviceTags.length > 0) {
    log(`Service tags: ${serviceTags.join(", ")}`);
  }

  return {
    skipped: false,
    tag: releaseTag,
    title,
    bumped,
    serviceTags,
  };
}

export { DEPLOYABLE_DIRS };

const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  createDraftRelease();
}
