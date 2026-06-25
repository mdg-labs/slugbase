import { describe, expect, it } from "vitest";

import { incrementSemver } from "./ci/probe-version.mjs";
import {
  deriveRequiredConsumers,
  findAffectedSharedLibs,
  formatFailureMessage,
  isIgnoredPath,
  parsePrePushLine,
} from "./lib/package-version-policy.mjs";
import { parseBumpChoice, parseCliArgs } from "./bump-package-versions.mjs";

describe("findAffectedSharedLibs", () => {
  it("detects shared-types source changes", () => {
    expect(
      findAffectedSharedLibs(["packages/shared-types/src/contracts/auth.contract.ts"]),
    ).toEqual(["packages/shared-types"]);
  });

  it("ignores markdown and spec-only edits under shared libs", () => {
    expect(findAffectedSharedLibs(["packages/ui/README.md", "packages/ui/src/foo.spec.ts"])).toEqual(
      [],
    );
  });

  it("merges consumers for multiple shared libs", () => {
    expect(
      findAffectedSharedLibs([
        "packages/shared-types/src/index.ts",
        "packages/ui/src/Button.tsx",
      ]),
    ).toEqual(["packages/shared-types", "packages/ui"]);
  });
});

describe("deriveRequiredConsumers", () => {
  it("maps shared-types to all deployables", () => {
    const consumers = deriveRequiredConsumers(["packages/shared-types"]);
    expect(consumers).toContain("packages/backend");
    expect(consumers).toContain("packages/web");
    expect(consumers).toContain("packages/marketing");
    expect(consumers).toContain("packages/admin");
  });

  it("maps db-admin to admin only", () => {
    expect(deriveRequiredConsumers(["packages/db-admin"])).toEqual(["packages/admin"]);
  });
});

describe("isIgnoredPath", () => {
  it("ignores package.json under packages", () => {
    expect(isIgnoredPath("packages/shared-types/package.json")).toBe(true);
  });

  it("does not ignore deployable source files", () => {
    expect(isIgnoredPath("packages/web/app/routes/home.tsx")).toBe(false);
  });
});

describe("formatFailureMessage", () => {
  it("points operators to pnpm bump:versions", () => {
    const message = formatFailureMessage("origin/staging", [
      {
        dir: "packages/web",
        name: "@slugbase/web",
        reasons: ["direct"],
        currentVersion: "0.1.2",
        remoteVersion: "0.1.2",
        sampleFiles: ["packages/web/app/root.tsx"],
      },
    ]);

    expect(message).toContain("check-push-version-bumps: FAIL");
    expect(message).toContain("pnpm bump:versions");
    expect(message).toContain("@slugbase/web");
    expect(message).toContain("packages/web/app/root.tsx");
  });
});

describe("parsePrePushLine", () => {
  it("parses pre-push stdin format", () => {
    expect(
      parsePrePushLine(
        "refs/heads/staging abc123 refs/heads/staging def456",
      ),
    ).toEqual({
      localRef: "refs/heads/staging",
      localSha: "abc123",
      remoteRef: "refs/heads/staging",
      remoteSha: "def456",
    });
  });
});

describe("parseCliArgs", () => {
  it("parses dry-run and base", () => {
    expect(parseCliArgs(["--dry-run", "--base", "origin/staging"])).toEqual({
      dryRun: true,
      baseRef: "origin/staging",
      assignments: [],
    });
  });

  it("parses non-interactive assignments after --", () => {
    expect(parseCliArgs(["--", "web", "patch", "backend", "minor"])).toEqual({
      dryRun: false,
      assignments: [
        { shortName: "web", level: "patch" },
        { shortName: "backend", level: "minor" },
      ],
    });
  });
});

describe("parseBumpChoice", () => {
  it("defaults empty input to patch", () => {
    expect(parseBumpChoice("")).toBe("patch");
  });

  it("distinguishes major M from minor m", () => {
    expect(parseBumpChoice("M")).toBe("major");
    expect(parseBumpChoice("m")).toBe("minor");
  });
});

describe("incrementSemver", () => {
  it("bumps patch minor and major", () => {
    expect(incrementSemver("1.2.3", "patch")).toBe("1.2.4");
    expect(incrementSemver("1.2.3", "minor")).toBe("1.3.0");
    expect(incrementSemver("1.2.3", "major")).toBe("2.0.0");
  });
});
