#!/usr/bin/env node
/**
 * Create an aggregate draft GitHub Release after Changesets publish.
 * Title: package list (≤3) or "Release YYYY-MM-DD". Tag: release-YYYY-MM-DD[*].
 */
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** @type {Record<string, string>} */
const PKG_TO_DIR = {
  "@slugbase/backend": "packages/backend",
  "@slugbase/web": "packages/web",
  "@slugbase/marketing": "packages/marketing",
  "@slugbase/admin": "packages/admin",
};

/** @type {Array<{ name: string; version: string }>} */
const published = JSON.parse(process.env.PUBLISHED_PACKAGES ?? "[]");

if (published.length === 0) {
  console.log("No published packages — skipping draft release");
  process.exit(0);
}

const date = new Date().toISOString().slice(0, 10);
const title =
  published.length <= 3
    ? published.map((pkg) => `${pkg.name}@${pkg.version}`).join(", ")
    : `Release ${date}`;

/** @type {string[]} */
const bodyParts = [];
for (const pkg of published) {
  const dir = PKG_TO_DIR[pkg.name];
  if (!dir) {
    console.warn(`Unknown package ${pkg.name} — skipping changelog section`);
    continue;
  }
  const changelogPath = path.join(dir, "CHANGELOG.md");
  if (!fs.existsSync(changelogPath)) {
    console.warn(`Missing ${changelogPath} — skipping changelog section`);
    continue;
  }
  const content = fs.readFileSync(changelogPath, "utf8");
  const section = extractVersionSection(content, pkg.version);
  if (section) {
    bodyParts.push(`## ${pkg.name}@${pkg.version}\n\n${section}`);
  }
}

const body =
  bodyParts.length > 0 ? bodyParts.join("\n\n") : `Packages: ${title}`;

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
fs.writeFileSync(notesFile, body);
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
 * @param {string} content
 * @param {string} version
 */
function extractVersionSection(content, version) {
  const header = `## ${version}`;
  const idx = content.indexOf(header);
  if (idx === -1) {
    return null;
  }
  const start = idx + header.length;
  const nextHeader = content.indexOf("\n## ", start);
  return (nextHeader === -1 ? content.slice(start) : content.slice(start, nextHeader)).trim();
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
