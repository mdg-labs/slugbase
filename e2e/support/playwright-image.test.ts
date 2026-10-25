import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { parsePlaywrightImage } from "./playwright-image.ts";

const DIGEST = `sha256:${"a".repeat(64)}`;
const dockerfile = (reference: string): string => `# comment\nFROM ${reference}\n`;

const dockerfileText = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
const workflowText = readFileSync(new URL("../../.github/workflows/e2e.yml", import.meta.url), "utf8");

// The version the lockfile resolved and pnpm installed for the journeys.
const installed = JSON.parse(
  readFileSync(createRequire(import.meta.url).resolve("@playwright/test/package.json"), "utf8"),
) as { version: string };

void describe("the Playwright image of the journeys", () => {
  void it("reads the version and the digest of the tag", () => {
    assert.deepEqual(parsePlaywrightImage(dockerfile(`mcr.microsoft.com/playwright:v1.64.0-noble@${DIGEST}`)), {
      version: "1.64.0",
      digest: DIGEST,
    });
  });

  void it("refuses a floating tag, a missing digest, another image and a second FROM line", () => {
    assert.throws(() => parsePlaywrightImage(dockerfile("mcr.microsoft.com/playwright:latest")), /FROM line must be/);
    assert.throws(() => parsePlaywrightImage(dockerfile("mcr.microsoft.com/playwright:v1.64.0-noble")), /FROM line must be/);
    assert.throws(() => parsePlaywrightImage(dockerfile(`mcr.microsoft.com/playwright:v1.64-noble@${DIGEST}`)), /FROM line must be/);
    assert.throws(() => parsePlaywrightImage(dockerfile(`node:24@${DIGEST}`)), /FROM line must be/);
    assert.throws(
      () =>
        parsePlaywrightImage(
          `${dockerfile(`mcr.microsoft.com/playwright:v1.64.0-noble@${DIGEST}`)}FROM mcr.microsoft.com/playwright:v1.64.0-noble@${DIGEST}\n`,
        ),
      /exactly one FROM line/,
    );
    assert.throws(() => parsePlaywrightImage("# no image\n"), /exactly one FROM line/);
  });

  void it("is the version of @playwright/test that pnpm resolved", () => {
    assert.equal(parsePlaywrightImage(dockerfileText).version, installed.version);
  });

  void it("differs from a version of @playwright/test it does not match", () => {
    const image = parsePlaywrightImage(dockerfile(`mcr.microsoft.com/playwright:v0.0.1-noble@${DIGEST}`));
    assert.notEqual(image.version, installed.version);
  });

  void it("is what the workflow runs the journeys in, with no browser install on the runner", () => {
    assert.match(workflowText, /bash e2e\/in-image\.sh/);
    assert.doesNotMatch(workflowText, /playwright install/);
    assert.doesNotMatch(workflowText, /\bapt(-get)?\b/);
  });

  void it("builds the workspace packages the journeys import before it runs them", () => {
    const steps = workflowText.split(/^ {6}- /m);
    const indexOf = (pattern: RegExp): number => steps.findIndex((step) => pattern.test(step));
    const build = indexOf(/^\s*run: pnpm turbo run build --filter='?@slugbase\/e2e\^\.\.\.'?\s*$/m);
    const journeys = indexOf(/^\s*run: bash e2e\/with-stack\.sh /m);
    assert.notEqual(journeys, -1, "the step that runs the journeys is missing");
    assert.notEqual(build, -1, "no step builds the workspace packages of @slugbase/e2e before the journeys");
    assert.ok(build < journeys, "the workspace build must come before the journeys");
  });
});
