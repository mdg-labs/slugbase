#!/usr/bin/env node
/**
 * Create a draft GitHub Release after api/web production deploy.
 * Title from package.json versions; body from git log since last release-* tag.
 */
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const API_DIR = "packages/backend";
const WEB_DIR = "packages/web";

const deployApi = process.env.DEPLOY_API === "true";
const deployWeb = process.env.DEPLOY_WEB === "true";

if (!deployApi && !deployWeb) {
  console.log("Neither api nor web deployed — skipping draft release");
  process.exit(0);
}

/**
 * @param {string} pkgDir
 */
function readPackageVersion(pkgDir) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"),
  );
  return manifest.version;
}

const backendVer = readPackageVersion(API_DIR);
const webVer = readPackageVersion(WEB_DIR);

/** @type {string[]} */
const titleParts = [];
if (deployApi) {
  titleParts.push(`API ${backendVer}`);
}
if (deployWeb) {
  titleParts.push(`Web ${webVer}`);
}
const title = `SlugBase ${titleParts.join(" · ")}`;

const lastTag = findLastReleaseTag();
const logRange = lastTag ? `${lastTag}..HEAD` : "HEAD";
const body = execFileSync(
  "git",
  ["log", logRange, "--pretty=format:- %s (%h)", "--no-merges"],
  { encoding: "utf8" },
).trim();

const notesBody =
  body.length > 0
    ? `## Changes since ${lastTag ?? "initial release"}\n\n${body}`
    : `Packages: ${title}`;

const date = new Date().toISOString().slice(0, 10);
let tag = `release-${date}`;
let suffix = 1;
while (tagExists(tag)) {
  suffix += 1;
  tag = `release-${date}-${suffix}`;
}

execSync(`git tag -a ${shellQuote(tag)} -m ${shellQuote(title)}`, {
  stdio: "inherit",
});
execSync(`git push origin ${shellQuote(tag)}`, { stdio: "inherit" });

const notesFile = path.join(process.cwd(), ".draft-release-notes.md");
fs.writeFileSync(notesFile, notesBody);
try {
  execFileSync(
    "gh",
    ["release", "create", tag, "--title", title, "--draft", "--notes-file", notesFile],
    { stdio: "inherit", env: process.env },
  );
} finally {
  fs.rmSync(notesFile, { force: true });
}

console.log(`Created draft release ${tag}: ${title}`);

/**
 * @returns {string | null}
 */
function findLastReleaseTag() {
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
 * @param {string} tag
 */
function tagExists(tag) {
  try {
    execSync(`git rev-parse ${shellQuote(`refs/tags/${tag}`)}`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} value
 */
function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
