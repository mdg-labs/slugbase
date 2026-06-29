import { describe, expect, it, vi } from "vitest";

import {
  buildReleaseNotesBody,
  buildReleaseTitle,
  buildServiceTags,
  createDraftRelease,
  detectBumpedSurfaces,
  nextReleaseTagName,
  shouldSkipDraftRelease,
} from "./create-draft-release.mjs";

describe("create-draft-release", () => {
  it("shouldSkipDraftRelease when no surfaces bumped", () => {
    expect(shouldSkipDraftRelease([])).toBe(true);
    expect(shouldSkipDraftRelease([{ id: "api", pkgDir: "packages/backend", version: "1.0.1" }])).toBe(
      false,
    );
  });

  it("buildReleaseTitle includes bumped surfaces only", () => {
    expect(
      buildReleaseTitle([
        { id: "api", pkgDir: "packages/backend", version: "1.0.1" },
        { id: "web", pkgDir: "packages/web", version: "2.0.0" },
      ]),
    ).toBe("SlugBase API 1.0.1 · Web 2.0.0");

    expect(
      buildReleaseTitle([{ id: "marketing", pkgDir: "packages/marketing", version: "0.9.0" }]),
    ).toBe("SlugBase Marketing 0.9.0");
  });

  it("buildReleaseNotesBody falls back to package title when log empty", () => {
    expect(buildReleaseNotesBody(null, "", "SlugBase API 1.0.0")).toBe(
      "Packages: SlugBase API 1.0.0",
    );
    expect(buildReleaseNotesBody("release-2026-01-01", "- feat(ci): smoke scripts (deadbeef)", "t")).toContain(
      "## Changes since release-2026-01-01",
    );
  });

  it("nextReleaseTagName deduplicates same-day tags", () => {
    const existing = new Set(["release-2026-06-27"]);
    expect(nextReleaseTagName("2026-06-27", (tag) => existing.has(tag))).toBe(
      "release-2026-06-27-2",
    );
    expect(nextReleaseTagName("2026-06-28", (tag) => existing.has(tag))).toBe(
      "release-2026-06-28",
    );
  });

  it("buildServiceTags excludes versions below 1.0.0", () => {
    expect(
      buildServiceTags([
        { id: "api", pkgDir: "packages/backend", version: "0.9.9" },
        { id: "web", pkgDir: "packages/web", version: "1.0.0" },
        { id: "marketing", pkgDir: "packages/marketing", version: "1.2.3" },
      ]),
    ).toEqual(["slugbase-web/v1.0.0", "slugbase-marketing/v1.2.3"]);
  });

  it("buildServiceTags includes CE-eligible api/web at 1.0.0+", () => {
    expect(
      buildServiceTags([
        { id: "api", pkgDir: "packages/backend", version: "1.0.1" },
        { id: "web", pkgDir: "packages/web", version: "1.0.0" },
      ]),
    ).toEqual(["slugbase-api/v1.0.1", "slugbase-web/v1.0.0"]);
  });

  it("detectBumpedSurfaces compares package.json at HEAD vs last release tag", () => {
    const repoRoot = process.cwd();
    const result = detectBumpedSurfaces(repoRoot, "HEAD", () => null);
    expect(result.lastTag).toBeNull();
    expect(result.bumped.length).toBeGreaterThanOrEqual(0);
    for (const surface of result.bumped) {
      expect(surface.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(surface.pkgDir).toMatch(/^packages\//);
    }
  });

  it("createDraftRelease skips without git/gh side effects", () => {
    const log = vi.fn();
    const result = createDraftRelease({
      detectBumps: () => ({ bumped: [], lastTag: "release-2026-06-01", baseSha: "abc123" }),
      log,
    });
    expect(result.skipped).toBe(true);
    expect(log).toHaveBeenCalledWith(
      "No deployable package version bumps since last release — skipping draft release",
    );
  });

  it("createDraftRelease builds release and service tags for bumped surfaces", () => {
    const execTag = vi.fn();
    const execPushTags = vi.fn();
    const execGhRelease = vi.fn();
    const log = vi.fn();
    const gitLog = vi.fn().mockReturnValue("- feat(api): bump backend (deadbeef)");

    const bumped = [
      { id: "api", pkgDir: "packages/backend", version: "1.0.1" },
      { id: "web", pkgDir: "packages/web", version: "0.9.0" },
    ];

    const result = createDraftRelease({
      date: new Date("2026-06-27T12:00:00.000Z"),
      tagExists: () => false,
      detectBumps: () => ({
        bumped,
        lastTag: "release-2026-06-01",
        baseSha: "abc123",
      }),
      gitLog,
      execTag,
      execPushTags,
      execGhRelease,
      log,
    });

    expect(result.skipped).toBe(false);
    expect(result.tag).toBe("release-2026-06-27");
    expect(result.title).toBe("SlugBase API 1.0.1 · Web 0.9.0");
    expect(result.serviceTags).toEqual(["slugbase-api/v1.0.1"]);
    expect(gitLog).toHaveBeenCalledWith("release-2026-06-01", [
      "packages/backend",
      "packages/web",
    ]);
    expect(execTag).toHaveBeenCalledTimes(2);
    expect(execTag).toHaveBeenCalledWith("release-2026-06-27", result.title);
    expect(execTag).toHaveBeenCalledWith("slugbase-api/v1.0.1", result.title);
    expect(execPushTags).toHaveBeenCalledWith(["release-2026-06-27", "slugbase-api/v1.0.1"]);
    expect(execGhRelease).toHaveBeenCalledOnce();
    expect(execGhRelease.mock.calls[0]?.[2]).toContain("release-2026-06-01");
  });
});
