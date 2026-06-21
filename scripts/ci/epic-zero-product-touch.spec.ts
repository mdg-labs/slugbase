import { execSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "../..");

const FORBIDDEN_PREFIXES = [
  "packages/backend/",
  "packages/web/",
  "packages/shared-types/",
  "packages/email-templates/",
  "packages/marketing/",
  "packages/ui/",
] as const;

function resolveBaseRef(): string {
  const fromEnv = process.env.EPIC_ZERO_TOUCH_BASE_REF?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  try {
    return execSync("git merge-base HEAD origin/staging", {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim();
  } catch {
    return "HEAD~1";
  }
}

function listChangedFiles(baseRef: string): string[] {
  const output = execSync(`git diff --name-only ${baseRef}...HEAD`, {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });

  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

describe("admin epic zero product touch", () => {
  it("does not modify core product packages", () => {
    const baseRef = resolveBaseRef();
    const changed = listChangedFiles(baseRef);
    const forbidden = changed.filter((file) =>
      FORBIDDEN_PREFIXES.some((prefix) => file.startsWith(prefix)),
    );

    expect(
      forbidden,
      `Core product paths must not change (base ${baseRef}): ${forbidden.join(", ")}`,
    ).toEqual([]);
  });
});
