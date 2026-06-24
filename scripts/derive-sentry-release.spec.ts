import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  deriveSentryRelease,
  isSentryPackage,
  shortGitSha,
} from "./derive-sentry-release.mjs";

const repoRoot = join(import.meta.dirname, "..");
const deriveScript = join(repoRoot, ".github/scripts/derive-sentry-release.sh");

function runDeriveScript(packageName: "api" | "web", gitSha: string) {
  return execFileSync("bash", [deriveScript, "--package", packageName], {
    cwd: repoRoot,
    env: { ...process.env, GIT_SHA: gitSha },
    encoding: "utf8",
  });
}

describe("deriveSentryRelease", () => {
  it("formats api releases from the backend package version", () => {
    expect(
      deriveSentryRelease({
        packageName: "api",
        packageVersion: "0.1.0",
        gitSha: "995c3b3c2d8bfd69e2a4f1f99f10df2f9d017b8b",
      }),
    ).toBe("slugbase-api@0.1.0+995c3b3");
  });

  it("formats web releases from the web package version", () => {
    expect(
      deriveSentryRelease({
        packageName: "web",
        packageVersion: "0.1.1",
        gitSha: "abc1234",
      }),
    ).toBe("slugbase-web@0.1.1+abc1234");
  });

  it("rejects missing git SHA", () => {
    expect(() =>
      deriveSentryRelease({
        packageName: "api",
        packageVersion: "1.0.0",
        gitSha: "",
      }),
    ).toThrow(/git SHA is required/);
  });
});

describe("shortGitSha", () => {
  it("truncates long SHAs to seven characters", () => {
    expect(shortGitSha("995c3b3c2d8bfd69e2a4f1f99f10df2f9d017b8b")).toBe(
      "995c3b3",
    );
  });
});

describe("isSentryPackage", () => {
  it("accepts api and web only", () => {
    expect(isSentryPackage("api")).toBe(true);
    expect(isSentryPackage("web")).toBe(true);
    expect(isSentryPackage("marketing")).toBe(false);
  });
});

describe("derive-sentry-release.sh", () => {
  it("derives api release from packages/backend version, not root slugbase@", () => {
    const output = runDeriveScript(
      "api",
      "995c3b3c2d8bfd69e2a4f1f99f10df2f9d017b8b",
    );

    expect(output).toContain("slugbase-api@0.1.0+995c3b3");
    expect(output).not.toContain("slugbase@0.1.5");
  });

  it("derives web release from packages/web version", () => {
    const output = runDeriveScript(
      "web",
      "995c3b3c2d8bfd69e2a4f1f99f10df2f9d017b8b",
    );

    expect(output).toContain("slugbase-web@0.1.0+995c3b3");
  });
});
