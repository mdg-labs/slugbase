import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  formatViolationReport,
  scanForBannedFontRefs,
  scanPattern,
  resolveRipgrepBinary,
} from "./check-no-external-fonts.mjs";

describe("resolveRipgrepBinary", () => {
  it("returns a usable ripgrep path", () => {
    expect(resolveRipgrepBinary()).toMatch(/rg$/);
  });
});

describe("scanForBannedFontRefs", () => {
  it("passes on the current repository tree", () => {
    const repoRoot = join(import.meta.dirname, "..");
    const result = scanForBannedFontRefs(repoRoot);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("flags fonts.googleapis.com under packages/**", () => {
    const root = mkdtempSync(join(tmpdir(), "slugbase-font-check-"));
    try {
      const cssDir = join(root, "packages", "ui", "src");
      mkdirSync(cssDir, { recursive: true });
      writeFileSync(
        join(cssDir, "bad.css"),
        "@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans');\n",
      );

      const result = scanForBannedFontRefs(root);
      expect(result.ok).toBe(false);
      expect(result.violations.some((v) => v.patternId === "google-fonts-api")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("flags fonts.gstatic.com under packages/**", () => {
    const root = mkdtempSync(join(tmpdir(), "slugbase-font-check-"));
    try {
      const cssDir = join(root, "packages", "web", "app");
      mkdirSync(cssDir, { recursive: true });
      writeFileSync(
        join(cssDir, "fonts.css"),
        "src: url('https://fonts.gstatic.com/s/ibmplexsans/v1.woff2') format('woff2');\n",
      );

      const result = scanForBannedFontRefs(root);
      expect(result.ok).toBe(false);
      expect(result.violations.some((v) => v.patternId === "google-fonts-static")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("flags external HTTPS font @import in CSS only", () => {
    const root = mkdtempSync(join(tmpdir(), "slugbase-font-check-"));
    try {
      const cssDir = join(root, "packages", "admin", "src");
      mkdirSync(cssDir, { recursive: true });
      writeFileSync(
        join(cssDir, "theme.css"),
        "@import url(\"https://cdn.example.com/fonts/inter.css\");\n",
      );
      writeFileSync(
        join(cssDir, "notes.ts"),
        "const href = \"@import url('https://cdn.example.com/fonts/inter.css')\";\n",
      );

      const rgBinary = resolveRipgrepBinary();
      const cssViolations = scanPattern(root, rgBinary, {
        id: "external-font-import",
        pattern: "@import\\s+url\\(\\s*['\"]https://[^'\"]*font",
        fileGlob: "*.css",
        description: "External HTTPS @import url(...) referencing fonts in CSS",
      });

      expect(cssViolations).toHaveLength(1);
      expect(cssViolations[0]?.file).toContain("theme.css");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("allows self-hosted @fontsource imports", () => {
    const root = mkdtempSync(join(tmpdir(), "slugbase-font-check-"));
    try {
      const cssDir = join(root, "packages", "ui", "src", "styles");
      mkdirSync(cssDir, { recursive: true });
      writeFileSync(
        join(cssDir, "ibm-plex-fonts.css"),
        "@import '@fontsource/ibm-plex-sans/400.css';\n",
      );

      const result = scanForBannedFontRefs(root);
      expect(result.ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("formatViolationReport", () => {
  it("includes file location and remediation hint", () => {
    const report = formatViolationReport([
      {
        patternId: "google-fonts-api",
        description: "Google Fonts CSS API (fonts.googleapis.com)",
        file: "packages/ui/src/bad.css",
        lineNumber: 1,
        line: "@import url('https://fonts.googleapis.com/css2');",
      },
    ]);

    expect(report).toContain("check-no-external-fonts:");
    expect(report).toContain("packages/ui/src/bad.css:1");
    expect(report).toContain("@fontsource");
  });
});
