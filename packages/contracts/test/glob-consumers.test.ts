import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Document, Ruleset, type RulesetDefinition, Spectral } from "@stoplight/spectral-core";
import parsers from "@stoplight/spectral-parsers";
import { truthy } from "@stoplight/spectral-functions";
import { describe, expect, it } from "vitest";

/*
 * minimatch 11 has no callable or default export, and the repository overrides every consumer to it
 * (pnpm.overrides, pnpm.patchedDependencies). These tests drive the two consumers' glob paths so a
 * consumer that cannot call it fails here and not on the first config line that reaches it.
 */

const packageDir = fileURLToPath(new URL("..", import.meta.url));

interface RedoclyUrlReader {
  readFileFromUrl: (
    url: string,
    config: {
      headers: { matches: string; name: string; value: string }[];
      customFetch: (url: string, init: { headers: Record<string, string> }) => Promise<Response>;
    },
  ) => Promise<{ body: string }>;
}

function redoclyUtils(): RedoclyUrlReader {
  const fromOpenapiTypescript = createRequire(realpathSync(join(packageDir, "node_modules/openapi-typescript/package.json")));
  const utils: unknown = fromOpenapiTypescript(fromOpenapiTypescript.resolve("@redocly/openapi-core/lib/utils.js"));
  return utils as RedoclyUrlReader;
}

async function headersSentTo(url: string, matches: string): Promise<Record<string, string>> {
  let sent: Record<string, string> = {};
  await redoclyUtils().readFileFromUrl(url, {
    headers: [{ matches, name: "x-glob", value: "matched" }],
    customFetch: (_url, init) => {
      sent = init.headers;
      return Promise.resolve(new Response("ok", { headers: { "content-type": "text/plain" } }));
    },
  });
  return sent;
}

const RULESET_SOURCE = join(packageDir, "spectral/ruleset.json");

const OVERRIDE_RULESET: RulesetDefinition = {
  rules: {
    "needs-title": { given: "$.info", severity: "error", then: { field: "title", function: truthy } },
  },
  overrides: [{ files: ["generated/*.json"], rules: { "needs-title": "off" } }],
};

async function codesFor(source: string): Promise<unknown[]> {
  const spectral = new Spectral();
  spectral.setRuleset(new Ruleset(OVERRIDE_RULESET, { source: RULESET_SOURCE }));
  const results = await spectral.run(new Document('{"info":{}}', parsers.Json, source));
  return results.map((result) => result.code);
}

describe("spectral ruleset overrides", () => {
  it("applies an override to a file its glob matches", async () => {
    expect(await codesFor(join(packageDir, "spectral/generated/openapi.json"))).toEqual([]);
  });

  it("leaves a file its glob does not match under the rule", async () => {
    expect(await codesFor(join(packageDir, "spectral/other/openapi.json"))).toEqual(["needs-title"]);
  });
});

describe("redocly resolve.http.headers", () => {
  it("sends a header to a url its pattern matches", async () => {
    expect(await headersSentTo("https://example.com/specs/api.yaml", "https://example.com/**")).toEqual({ "x-glob": "matched" });
  });

  it("matches a pattern that names no protocol against the bare host", async () => {
    expect(await headersSentTo("https://example.com/specs/api.yaml", "example.com/**")).toEqual({ "x-glob": "matched" });
  });

  it("sends nothing to a url its pattern does not match", async () => {
    expect(await headersSentTo("https://other.test/specs/api.yaml", "https://example.com/**")).toEqual({});
  });
});
