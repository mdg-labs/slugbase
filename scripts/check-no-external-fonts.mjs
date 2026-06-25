#!/usr/bin/env node
/**
 * Fail CI when packages/** reference external font CDNs (Google Fonts, etc.).
 * Scans packages/ only — docs/prototype CSS is out of scope (spec §18).
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { rgPath } from "@vscode/ripgrep";

/** @typedef {{ patternId: string; description: string; file: string; line: string; lineNumber: number }} FontViolation */

/** @type {ReadonlyArray<{ id: string; pattern: string; fileGlob?: string; description: string }>} */
export const BANNED_PATTERNS = [
  {
    id: "google-fonts-api",
    pattern: "fonts\\.googleapis\\.com",
    description: "Google Fonts CSS API (fonts.googleapis.com)",
  },
  {
    id: "google-fonts-static",
    pattern: "fonts\\.gstatic\\.com",
    description: "Google Fonts static CDN (fonts.gstatic.com)",
  },
  {
    id: "external-font-import",
    pattern: "@import\\s+url\\(\\s*['\"]https://[^'\"]*font",
    fileGlob: "*.css",
    description: "External HTTPS @import url(...) referencing fonts in CSS",
  },
];

/**
 * @returns {string}
 */
export function resolveRipgrepBinary() {
  if (existsSync(rgPath)) {
    return rgPath;
  }

  try {
    const systemRg = execFileSync("which", ["rg"], { encoding: "utf8" }).trim();
    if (systemRg && existsSync(systemRg)) {
      return systemRg;
    }
  } catch {
    // fall through
  }

  throw new Error(
    "check-no-external-fonts: ripgrep (rg) is required — run pnpm install or install rg system-wide",
  );
}

/**
 * @param {string} repoRoot
 * @param {string} rgBinary
 * @param {{ id: string; pattern: string; fileGlob?: string; description: string }} rule
 * @returns {FontViolation[]}
 */
export function scanPattern(repoRoot, rgBinary, rule) {
  const packagesDir = join(repoRoot, "packages");
  if (!existsSync(packagesDir)) {
    return [];
  }

  /** @type {string[]} */
  const args = ["-n", "--no-heading", "-i", rule.pattern, "packages"];
  if (rule.fileGlob) {
    args.push("-g", rule.fileGlob);
  }

  let output = "";
  try {
    output = execFileSync(rgBinary, args, {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    const execError = /** @type {NodeJS.ErrnoException & { status?: number; stdout?: string }} */ (
      error
    );
    if (execError.status === 1) {
      return [];
    }
    throw error;
  }

  /** @type {FontViolation[]} */
  const violations = [];
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line) {
      continue;
    }

    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) {
      continue;
    }

    const secondColon = line.indexOf(":", colonIndex + 1);
    if (secondColon === -1) {
      continue;
    }

    const file = line.slice(0, colonIndex);
    const lineNumber = Number(line.slice(colonIndex + 1, secondColon));
    const matchLine = line.slice(secondColon + 1);

    if (!file || Number.isNaN(lineNumber)) {
      continue;
    }

    violations.push({
      patternId: rule.id,
      description: rule.description,
      file,
      lineNumber,
      line: matchLine,
    });
  }

  return violations;
}

/**
 * @param {string} [repoRoot]
 * @returns {{ ok: boolean; violations: FontViolation[] }}
 */
export function scanForBannedFontRefs(repoRoot = process.cwd()) {
  const rgBinary = resolveRipgrepBinary();
  const violations = BANNED_PATTERNS.flatMap((rule) => scanPattern(repoRoot, rgBinary, rule));
  return { ok: violations.length === 0, violations };
}

/**
 * @param {FontViolation[]} violations
 * @returns {string}
 */
export function formatViolationReport(violations) {
  const lines = [
    "check-no-external-fonts: external font CDN references are forbidden under packages/**.",
    "Self-host fonts (e.g. @fontsource/*) or bundle assets locally — see spec §18.",
    "",
  ];

  for (const violation of violations) {
    lines.push(
      `${violation.file}:${violation.lineNumber} [${violation.patternId}] ${violation.description}`,
      `  ${violation.line.trim()}`,
      "",
    );
  }

  return lines.join("\n").trimEnd();
}

/**
 * @param {string} [repoRoot]
 */
export function main(repoRoot = join(import.meta.dirname, "..")) {
  const { ok, violations } = scanForBannedFontRefs(repoRoot);
  if (!ok) {
    process.stderr.write(`${formatViolationReport(violations)}\n`);
    process.exit(1);
  }

  process.stdout.write("check-no-external-fonts: OK\n");
}

const isMain = process.argv[1]?.endsWith("check-no-external-fonts.mjs");
if (isMain) {
  main();
}
