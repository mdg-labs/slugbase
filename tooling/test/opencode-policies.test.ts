import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "./run.ts";

interface Policy {
  action: string;
  resource: string;
  effect: "allow" | "deny";
}

function loadPolicies(): Policy[] {
  const text = readFileSync(resolve(ROOT, ".opencode/opencode.jsonc"), "utf8");
  const json = text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
  const config = JSON.parse(json) as { policies: Policy[] };
  return config.policies;
}

function wildcardMatches(pattern: string, value: string): boolean {
  const source = pattern.replace(/[.+^${}()|[\]\\*?]/g, (ch) => {
    if (ch === "*") return ".*";
    if (ch === "?") return ".";
    return `\\${ch}`;
  });
  return new RegExp(`^${source}$`, "s").test(value);
}

function resourceMatches(pattern: string, value: string): boolean {
  if (wildcardMatches(pattern, value)) return true;
  return pattern.endsWith(" *") && wildcardMatches(pattern.slice(0, -2), value);
}

function evaluate(policies: Policy[], command: string): "allow" | "deny" {
  let effect: "allow" | "deny" = "allow";
  for (const policy of policies) {
    if (policy.action === "tool.use" && resourceMatches(policy.resource, `shell:${command}`)) {
      effect = policy.effect;
    }
  }
  return effect;
}

const policies = loadPolicies();

const DENIED = [
  "git add .",
  "git add ./",
  "git add -A",
  "git add --all",
];

const ALLOWED = [
  "git add ./packages/core/src/x.ts",
  "git add packages/core/src/x.ts",
  "git add .gitignore",
];

describe("opencode policies", () => {
  it("parses a non-empty policy list", () => {
    expect(policies.length).toBeGreaterThan(0);
  });

  it.each(DENIED)("denies %s", (command) => {
    expect(evaluate(policies, command)).toBe("deny");
  });

  it.each(ALLOWED)("allows %s", (command) => {
    expect(evaluate(policies, command)).toBe("allow");
  });
});
