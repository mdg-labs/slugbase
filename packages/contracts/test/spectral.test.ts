import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { lintOpenApi } from "../scripts/lint-openapi.ts";
import { ruleset } from "../spectral/slugbase.ruleset.ts";
import { createReportPackage } from "./report-package.ts";
import { SUBPROCESS_TIMEOUT_MS } from "./subprocess.ts";

const packageDir = new URL("..", import.meta.url).pathname;
const fixtures = join(packageDir, "test/fixtures/spectral");
const committed = join(packageDir, "generated/openapi.json");
const check = join(packageDir, "scripts/contracts-check.ts");
const directories: string[] = [];

interface Media {
  schema?: unknown;
}

interface Response {
  description: string;
  content?: Record<string, Media>;
}

interface Operation {
  operationId?: string;
  tags?: string[];
  "x-slugbase-auth"?: string;
  "x-slugbase-rate"?: string;
  "x-slugbase-reauth"?: unknown;
  responses: Record<string, Response>;
}

interface Fixture {
  paths: Record<string, Record<string, Operation>>;
}

function thingsOf(document: Fixture): Record<string, Operation> {
  const item = document.paths["/things"];
  if (item === undefined) {
    throw new Error("the fixture has no /things");
  }
  return item;
}

function getOf(document: Fixture): Operation {
  const operation = thingsOf(document)["get"];
  if (operation === undefined) {
    throw new Error("the fixture has no GET /things");
  }
  return operation;
}

function getOfPath(document: Fixture, path: string): Operation {
  const operation = document.paths[path]?.["get"];
  if (operation === undefined) {
    throw new Error(`the document has no GET ${path}`);
  }
  return operation;
}

function responseOf(document: Fixture, status: string): Response {
  const response = getOf(document).responses[status];
  if (response === undefined) {
    throw new Error(`the fixture has no ${status} response`);
  }
  return response;
}

function mediaOf(document: Fixture, status: string, mediaType: string): Media {
  const media = responseOf(document, status).content?.[mediaType];
  if (media === undefined) {
    throw new Error(`the fixture has no ${mediaType} body in ${status}`);
  }
  return media;
}

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "spectral-test-"));
  directories.push(dir);
  return dir;
}

function fixture(name: string): string {
  return join(fixtures, `${name}.openapi.json`);
}

/** The fixture `valid`, changed by `edit`, written to a scratch file. */
function variant(edit: (document: Fixture) => void): string {
  const document = JSON.parse(readFileSync(fixture("valid"), "utf8")) as Fixture;
  edit(document);
  const file = join(scratch(), "openapi.json");
  writeFileSync(file, JSON.stringify(document));
  return file;
}

function rulesIn(findings: readonly string[]): string[] {
  return [...new Set(findings.map((finding) => /^\[([^\]]+)\]/.exec(finding)?.[1] ?? finding))];
}

afterEach(() => {
  for (const dir of directories.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("the SlugBase Spectral ruleset", () => {
  it("makes every rule an error", () => {
    const rules = Object.entries(ruleset.rules);
    expect(rules.map(([name]) => name).sort()).toEqual([
      "slugbase-named-response-schema",
      "slugbase-operation-auth",
      "slugbase-operation-id",
      "slugbase-operation-rate",
      "slugbase-operation-reauth",
      "slugbase-operation-tag",
      "slugbase-problem-response",
    ]);
    for (const [name, rule] of rules) {
      expect(rule, name).toMatchObject({ severity: "error" });
    }
  });

  it("finds nothing in a compliant document", async () => {
    expect(await lintOpenApi(fixture("valid"))).toEqual([]);
  });

  it("finds nothing in the committed document", async () => {
    expect(await lintOpenApi(committed)).toEqual([]);
  });

  it.each([
    ["missing-operation-id", "slugbase-operation-id"],
    ["missing-tag", "slugbase-operation-tag"],
    ["missing-auth", "slugbase-operation-auth"],
    ["missing-rate", "slugbase-operation-rate"],
    ["missing-problem-response", "slugbase-problem-response"],
    ["inline-response-schema", "slugbase-named-response-schema"],
    ["inline-response-schema-via-ref", "slugbase-named-response-schema"],
  ])("%s violates only %s, and that rule fires", async (name, rule) => {
    const findings = await lintOpenApi(fixture(name));
    expect(rulesIn(findings)).toEqual([rule]);
    expect(findings).toHaveLength(1);
  });

  it("names the operation and the path of a finding", async () => {
    const [finding] = await lintOpenApi(fixture("missing-auth"));
    expect(finding).toBe(
      "[slugbase-operation-auth] GET /things (listThings) at #/paths/~1things/get: Operation must declare x-slugbase-auth",
    );
  });

  it("rejects empty values as missing", async () => {
    expect(rulesIn(await lintOpenApi(variant((d) => (getOf(d).operationId = ""))))).toEqual(["slugbase-operation-id"]);
    expect(rulesIn(await lintOpenApi(variant((d) => (getOf(d).tags = []))))).toEqual(["slugbase-operation-tag"]);
    expect(rulesIn(await lintOpenApi(variant((d) => (getOf(d)["x-slugbase-auth"] = ""))))).toEqual(["slugbase-operation-auth"]);
  });

  it("accepts x-slugbase-reauth when it is true and when it is absent", async () => {
    expect(await lintOpenApi(variant((d) => (getOf(d)["x-slugbase-reauth"] = true)))).toEqual([]);
    expect(await lintOpenApi(fixture("valid"))).toEqual([]);
  });

  it.each([false, "true", 1, null, {}, []])("refuses x-slugbase-reauth set to %j", async (value) => {
    const findings = await lintOpenApi(variant((d) => (getOf(d)["x-slugbase-reauth"] = value)));
    expect(rulesIn(findings)).toEqual(["slugbase-operation-reauth"]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("x-slugbase-reauth must be true when present");
  });

  it("holds every method of a path item to the rules", async () => {
    const file = variant((d) => {
      const post = structuredClone(getOf(d));
      delete post["x-slugbase-rate"];
      thingsOf(d)["post"] = post;
    });
    const findings = await lintOpenApi(file);
    expect(rulesIn(findings)).toEqual(["slugbase-operation-rate"]);
    expect(findings[0]).toContain("POST /things");
  });

  it("does not take a 4xx response without a problem body, or a 5xx one, for the problem response", async () => {
    const file = variant((d) => {
      const responses = getOf(d).responses;
      responses["500"] = responseOf(d, "400");
      delete responses["400"];
    });
    expect(rulesIn(await lintOpenApi(file))).toEqual(["slugbase-problem-response"]);
  });

  it("finds an inline object nested in an array, a composition or a media type of its own", async () => {
    const inline = { type: "object", properties: { id: { type: "string" } } };
    for (const schema of [
      { type: "array", items: inline },
      { oneOf: [{ $ref: "#/components/schemas/Thing" }, inline] },
      { $ref: "#/paths/~1things" },
    ]) {
      const file = variant((d) => (mediaOf(d, "200", "application/json").schema = schema));
      expect(rulesIn(await lintOpenApi(file)), JSON.stringify(schema)).toEqual(["slugbase-named-response-schema"]);
    }
    const file = variant((d) => {
      const content = responseOf(d, "200").content;
      if (content !== undefined) {
        content["text/csv"] = { schema: inline };
      }
    });
    expect(rulesIn(await lintOpenApi(file))).toEqual(["slugbase-named-response-schema"]);
  });

  it("accepts arrays of named schemas, primitives and bodiless responses", async () => {
    const file = variant((d) => {
      mediaOf(d, "200", "application/json").schema = { type: "array", items: { $ref: "#/components/schemas/Thing" } };
      const responses = getOf(d).responses;
      responses["204"] = { description: "Nothing" };
      responses["202"] = { description: "Text", content: { "text/plain": { schema: { type: "string" } } } };
    });
    expect(await lintOpenApi(file)).toEqual([]);
  });

  it("refuses to pass a document it cannot judge", async () => {
    await expect(lintOpenApi(join(scratch(), "missing.json"))).rejects.toThrow(/ENOENT/);
    await expect(lintOpenApi(variant((d) => {
        d.paths = {};
      }))).rejects.toThrow(/no operations/);
    const garbled = join(scratch(), "openapi.json");
    writeFileSync(garbled, "{ not json");
    await expect(lintOpenApi(garbled)).rejects.toThrow();
  });
});

describe("pnpm contracts:check and the Spectral ruleset", { timeout: SUBPROCESS_TIMEOUT_MS }, () => {
  let reportPackage = "";

  beforeAll(() => {
    reportPackage = createReportPackage();
  }, SUBPROCESS_TIMEOUT_MS);

  afterAll(() => {
    rmSync(reportPackage, { recursive: true, force: true });
  });

  function runCheck(generated: string) {
    return spawnSync(process.execPath, [check, "--generated", generated, "--package", reportPackage], {
      cwd: packageDir,
      encoding: "utf8",
    });
  }

  function generatedWith(document: string): string {
    const dir = scratch();
    copyFileSync(document, join(dir, "openapi.json"));
    copyFileSync(join(packageDir, "generated/schema.d.ts"), join(dir, "schema.d.ts"));
    return dir;
  }

  it("fails on a document whose operation lacks x-slugbase-auth, without any descriptor check", () => {
    const document = JSON.parse(readFileSync(committed, "utf8")) as Fixture;
    delete getOfPath(document, "/health")["x-slugbase-auth"];
    const dir = generatedWith(committed);
    writeFileSync(join(dir, "openapi.json"), `${JSON.stringify(document, null, 2)}\n`);

    const result = runCheck(dir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("slugbase-operation-auth");
    expect(result.stderr).toContain("GET /health (getHealth)");
    expect(result.stderr).toContain("#/paths/~1health/get");
  });

  it("passes the committed files through both checks", () => {
    const result = runCheck(join(packageDir, "generated"));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("reports the ruleset findings of an inline response schema", () => {
    const result = runCheck(generatedWith(fixture("inline-response-schema")));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("slugbase-named-response-schema");
  });

  it("reports drift and ruleset findings together", () => {
    const result = runCheck(generatedWith(fixture("missing-tag")));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("generated files differ");
    expect(result.stderr).toContain("openapi.json");
    expect(result.stderr).toContain("slugbase-operation-tag");
  });

  it("fails, rather than passes, when there is no document to lint", () => {
    const dir = scratch();
    const result = runCheck(dir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("openapi.json");
    expect(result.stderr).toContain("ENOENT");
  });
});
