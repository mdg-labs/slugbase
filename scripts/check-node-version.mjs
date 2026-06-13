#!/usr/bin/env node
/**
 * Fail fast when Node is below package.json engines (>=22.12.0).
 * Invoked from root preinstall; also runnable via: node scripts/check-node-version.mjs
 */

const MIN_MAJOR = 22;
const MIN_MINOR = 12;

const [major, minor] = process.versions.node.split(".").map((part) => Number(part));

if (
  Number.isNaN(major) ||
  Number.isNaN(minor) ||
  major < MIN_MAJOR ||
  (major === MIN_MAJOR && minor < MIN_MINOR)
) {
  console.error(
    [
      "",
      `SlugBase requires Node >=${MIN_MAJOR}.${MIN_MINOR}.0 (see package.json engines and .nvmrc).`,
      `Current: ${process.version}`,
      "",
      "Fix:",
      "  nvm install   # reads .nvmrc (22.12.0, matches CI)",
      "  nvm use",
      "  # or: source scripts/ci-env.sh",
      "",
    ].join("\n"),
  );
  process.exit(1);
}
