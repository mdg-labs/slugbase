import { getResponse } from "msw";
import { describe, expect, it } from "vitest";
import { createHandlers, listOperations, parseDocument, scenarioFromSearch, SCENARIOS, type Scenario } from "../src/msw.ts";
import { readOpenApiDocument } from "../src/msw/node.ts";
import { validatorFor } from "./support/schema.ts";

// The mock is generated from the committed document (doc 08 section 7): adding
// or changing an operation changes what these tests see, so a contract change
// that the mock cannot follow fails in the same commit.

const BASE = "http://mock.test";
const METHODS = ["get", "put", "post", "delete", "patch", "head", "options"];

const document = readOpenApiDocument();
const raw = document as unknown as Record<string, unknown>;

interface Declared {
  readonly operationId: string;
  readonly method: string;
  readonly path: string;
  readonly statuses: readonly number[];
  readonly schemas: ReadonlyMap<number, Record<string, unknown>>;
}

// An enumeration of the document that does not use the code under test.
function declared(): Declared[] {
  const found: Declared[] = [];
  const paths = raw.paths as Record<string, Record<string, Record<string, unknown>>>;
  for (const [path, item] of Object.entries(paths)) {
    for (const method of METHODS.filter((candidate) => item[candidate] !== undefined)) {
      const operation = item[method] ?? {};
      const responses = operation.responses as Record<string, { content?: Record<string, { schema?: unknown }> }>;
      const schemas = new Map<number, Record<string, unknown>>();
      for (const [status, response] of Object.entries(responses)) {
        const schema = Object.values(response.content ?? {})[0]?.schema;
        if (schema !== undefined) {
          schemas.set(Number(status), schema as Record<string, unknown>);
        }
      }
      found.push({
        operationId: String(operation.operationId),
        method,
        path,
        statuses: Object.keys(responses).map(Number),
        schemas,
      });
    }
  }
  return found;
}

const operations = declared();

function url(operation: Declared): string {
  return `${BASE}${operation.path.replaceAll(/\{[^}]+\}/g, "sample")}`;
}

async function answer(operation: Declared, scenario?: Scenario): Promise<Response> {
  const handlers = createHandlers(document, { baseUrl: BASE, ...(scenario === undefined ? {} : { scenario }) });
  const response = await getResponse(handlers, new Request(url(operation), { method: operation.method.toUpperCase() }));
  if (response === undefined) {
    throw new Error(`no handler answered ${operation.method} ${operation.path}`);
  }
  return response;
}

describe("the generated handlers", () => {
  it("cover the document, which declares operations at all", () => {
    expect(operations.length).toBeGreaterThan(0);
  });

  it("hold exactly one handler for every method and path of the document", () => {
    const handlers = createHandlers(document, { baseUrl: BASE });
    const handled = handlers.map((handler) => `${String(handler.info.method)} ${String(handler.info.path)}`).sort();
    const expected = operations
      .map((operation) => `${operation.method.toUpperCase()} ${BASE}${operation.path.replaceAll(/\{([^}]+)\}/g, ":$1")}`)
      .sort();
    expect(handled).toEqual(expected);
  });

  it("gain a handler for an operation added to the document", () => {
    const extended = parseDocument({
      ...raw,
      paths: {
        ...(raw.paths as object),
        "/api/v1/widgets/{widgetId}": {
          get: { operationId: "getWidget", responses: { 200: { description: "ok", content: { "application/json": { schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } } } } } },
        },
      },
    });
    const handlers = createHandlers(extended, { baseUrl: BASE });
    expect(handlers).toHaveLength(operations.length + 1);
    expect(handlers.map((handler) => String(handler.info.path))).toContain(`${BASE}/api/v1/widgets/:widgetId`);
  });

  it("refuse an operation they cannot answer instead of leaving it without a handler", () => {
    const binary = parseDocument({
      openapi: "3.1.0",
      paths: { "/export": { get: { operationId: "getExport", responses: { 200: { description: "ok", content: { "application/zip": { schema: { type: "string" } } } } } } } },
    });
    expect(() => createHandlers(binary)).toThrow(/getExport.*application\/zip/);
    const unnamed = parseDocument({ openapi: "3.1.0", paths: { "/x": { get: { responses: { 200: { description: "ok" } } } } } });
    expect(() => listOperations(unnamed)).toThrow(/no operationId/);
  });

  it("answer every operation with its declared success response, valid against the response schema", async () => {
    for (const operation of operations) {
      const status = Math.min(...operation.statuses.filter((candidate) => candidate < 400));
      const response = await answer(operation);
      expect(response.status, operation.operationId).toBe(status);
      const schema = operation.schemas.get(status);
      if (schema !== undefined && operation.method !== "head") {
        expect(response.headers.get("content-type"), operation.operationId).toContain("application/json");
        const body: unknown = await response.json();
        const result = validatorFor(raw, schema).safeParse(body);
        expect(result.success, `${operation.operationId}: ${JSON.stringify(result.error?.issues)}`).toBe(true);
      }
    }
  });

  it("answer the same bytes every time", async () => {
    for (const operation of operations) {
      expect(await (await answer(operation)).text(), operation.operationId).toBe(await (await answer(operation)).text());
    }
  });

  it("answer a declared error with application/problem+json that is valid against its schema", async () => {
    let problems = 0;
    for (const operation of operations) {
      for (const status of operation.statuses.filter((candidate) => candidate >= 400)) {
        const scenario: Scenario = { name: "forced", statuses: { [operation.operationId]: status } };
        const response = await answer(operation, scenario);
        expect(response.status, `${operation.operationId} ${String(status)}`).toBe(status);
        const schema = operation.schemas.get(status);
        if (schema !== undefined && response.headers.get("content-type") === "application/problem+json") {
          problems += 1;
          const body = (await response.json()) as Record<string, unknown>;
          expect(body.status).toBe(status);
          expect(typeof body.code).toBe("string");
          expect(validatorFor(raw, schema).safeParse(body).success, `${operation.operationId} ${String(status)}`).toBe(true);
        }
      }
    }
    expect(problems).toBeGreaterThan(0);
  });

  it("refuse a scenario that forces a status the operation does not declare", () => {
    const [first] = operations;
    const scenario: Scenario = { name: "wrong", statuses: { [first?.operationId ?? ""]: 418 } };
    expect(() => createHandlers(document, { baseUrl: BASE, scenario })).toThrow(/wrong.*418/);
  });

  it("answer a scenario fixture in place of the generated body", async () => {
    const scenario: Scenario = {
      name: "custom",
      fixtures: { getVersion: { name: "Custom", version: "9.9.9", commit: "abc", builtAt: "2026-01-01T00:00:00Z" } },
    };
    const version = operations.find((operation) => operation.operationId === "getVersion");
    expect(version).toBeDefined();
    expect(await (await answer(version as Declared, scenario)).json()).toMatchObject({ name: "Custom" });
  });

  it("serve the committed document itself for the OpenAPI operation", async () => {
    const operation = operations.find((candidate) => candidate.operationId === "getOpenApiDocument");
    expect(await (await answer(operation as Declared)).json()).toEqual(raw);
  });

  it("answer /api/config with a product name the shell shows", async () => {
    const operation = operations.find((candidate) => candidate.operationId === "getApiConfig");
    expect(await (await answer(operation as Declared)).json()).toMatchObject({ product: { name: "SlugBase Mock" } });
  });
});

describe("the scenario switch", () => {
  it("picks default when the page names none", () => {
    expect(scenarioFromSearch("")).toBe(SCENARIOS.default);
    expect(scenarioFromSearch("?other=1")).toBe(SCENARIOS.default);
  });

  it("picks the scenario named by ?scenario=", () => {
    const named: Scenario = { name: "named" };
    expect(scenarioFromSearch("?scenario=named&x=1", { default: SCENARIOS.default as Scenario, named })).toBe(named);
  });

  it("fails on a name it does not know, listing the known ones", () => {
    expect(() => scenarioFromSearch("?scenario=nope")).toThrow(/Unknown mock scenario "nope".*default/);
    expect(() => scenarioFromSearch("?scenario=constructor")).toThrow(/Unknown mock scenario/);
  });
});
