import { z } from "zod";
import {
  AUDIENCES,
  AUTH_POLICIES,
  HTTP_METHODS,
  RATE_BUCKETS,
  TOKEN_SCOPES,
  type OperationDefinition,
} from "../operations/define.ts";
import { ProblemSchema } from "../problem.ts";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const COMPONENT_PREFIX = "#/components/schemas/";
const DEFS_PREFIX = "#/$defs/";

/** One or more operation declarations the generator refuses to publish. */
export class OperationDeclarationError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`${String(problems.length)} operation declaration problem(s):\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "OperationDeclarationError";
    this.problems = problems;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonObject(value: Json | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function includes(list: readonly string[], value: unknown): boolean {
  return typeof value === "string" && list.includes(value);
}

function describeOperation(raw: unknown, index: number): string {
  if (isRecord(raw)) {
    const { operationId, method, path } = raw;
    if (typeof operationId === "string" && operationId !== "") {
      return `operation ${operationId}`;
    }
    if (typeof method === "string" && typeof path === "string") {
      return `operation #${String(index + 1)} (${method.toUpperCase()} ${path})`;
    }
  }
  return `operation #${String(index + 1)}`;
}

function pathParameters(path: string): string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1] ?? "");
}

function rewriteRefs(node: Json): Json {
  if (Array.isArray(node)) {
    return node.map(rewriteRefs);
  }
  if (typeof node === "object" && node !== null) {
    const out: JsonObject = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string" && value.startsWith(DEFS_PREFIX)) {
        out[key] = COMPONENT_PREFIX + value.slice(DEFS_PREFIX.length);
      } else {
        out[key] = rewriteRefs(value);
      }
    }
    return out;
  }
  return node;
}

/** Every object schema that lists properties but does not close itself, with where it sits. */
function openObjects(node: Json, components: Map<string, JsonObject>, at: string, seen: Set<string>): string[] {
  if (Array.isArray(node)) {
    return node.flatMap((item, i) => openObjects(item, components, `${at}[${String(i)}]`, seen));
  }
  if (!isJsonObject(node)) {
    return [];
  }
  const found: string[] = [];
  const ref = node["$ref"];
  if (typeof ref === "string" && ref.startsWith(COMPONENT_PREFIX)) {
    const id = ref.slice(COMPONENT_PREFIX.length);
    const target = components.get(id);
    if (target !== undefined && !seen.has(id)) {
      seen.add(id);
      found.push(...openObjects(target, components, id, seen));
    }
    return found;
  }
  if (node["properties"] !== undefined && node["additionalProperties"] !== false) {
    found.push(at);
  }
  for (const [key, value] of Object.entries(node)) {
    found.push(...openObjects(value, components, key === "properties" ? at : `${at}/${key}`, seen));
  }
  return found;
}

function sortKeys(node: Json): Json {
  if (Array.isArray(node)) {
    return node.map(sortKeys);
  }
  if (typeof node === "object" && node !== null) {
    const out: JsonObject = {};
    for (const key of Object.keys(node).sort()) {
      out[key] = sortKeys(node[key] ?? null);
    }
    return out;
  }
  return node;
}

class Converter {
  readonly components = new Map<string, JsonObject>();
  readonly problems: string[] = [];

  owner = "";

  /** A schema as OpenAPI 3.1 JSON Schema; named schemas are hoisted to components and referenced. */
  convert(schema: z.ZodType, io: "input" | "output"): JsonObject | undefined {
    let generated: JsonObject;
    try {
      generated = z.toJSONSchema(schema, { target: "draft-2020-12", io, unrepresentable: "throw" }) as JsonObject;
    } catch (error) {
      this.problems.push(`${this.owner}: schema cannot be expressed in OpenAPI (${(error as Error).message})`);
      return undefined;
    }
    const { $defs: defs, ...root } = generated;
    delete root["$schema"];
    if (isJsonObject(defs)) {
      for (const [id, definition] of Object.entries(defs)) {
        if (isJsonObject(definition)) {
          this.addComponent(id, rewriteRefs(definition) as JsonObject);
        }
      }
    }
    return rewriteRefs(root) as JsonObject;
  }

  private addComponent(id: string, definition: JsonObject): void {
    const existing = this.components.get(id);
    if (existing !== undefined && JSON.stringify(sortKeys(existing)) !== JSON.stringify(sortKeys(definition))) {
      this.problems.push(
        `${this.owner}: schema ${id} is generated differently than where it was first used; give request and response schemas their own ids`,
      );
      return;
    }
    this.components.set(id, definition);
  }

  resolve(schema: JsonObject): JsonObject {
    const ref = schema["$ref"];
    if (typeof ref === "string" && ref.startsWith(COMPONENT_PREFIX)) {
      return this.components.get(ref.slice(COMPONENT_PREFIX.length)) ?? schema;
    }
    return schema;
  }
}

function objectParameters(
  converter: Converter,
  schema: z.ZodObject,
  location: "path" | "query",
): JsonObject[] {
  const converted = converter.convert(schema, "input");
  if (converted === undefined) {
    return [];
  }
  const resolved = converter.resolve(converted);
  const properties = resolved["properties"];
  const required = resolved["required"];
  if (!isJsonObject(properties)) {
    return [];
  }
  const requiredNames = Array.isArray(required) ? required : [];
  return Object.entries(properties).map(([name, property]) => ({
    name,
    in: location,
    required: location === "path" || requiredNames.includes(name),
    schema: property,
  }));
}

function checkDeclaration(raw: unknown, index: number, seenIds: Set<string>, seenRoutes: Set<string>): string[] {
  const label = describeOperation(raw, index);
  if (!isRecord(raw)) {
    return [`${label}: is not an object`];
  }
  const problems: string[] = [];
  const need = (message: string): void => {
    problems.push(`${label}: ${message}`);
  };

  const { operationId, method, path, tag, auth, rate, scope, entitlement, audience, request, responses } = raw;

  if (typeof operationId !== "string" || !/^[a-z][A-Za-z0-9]*$/.test(operationId)) {
    need("operationId is required and must be camelCase");
  } else if (seenIds.has(operationId)) {
    need("operationId is declared more than once");
  } else {
    seenIds.add(operationId);
  }
  if (!includes(HTTP_METHODS, method)) {
    need(`method is required: one of ${HTTP_METHODS.join(", ")}`);
  }
  if (typeof path !== "string" || !path.startsWith("/")) {
    need("path is required and must start with /");
  } else if (typeof method === "string") {
    const route = `${method} ${path}`;
    if (seenRoutes.has(route)) {
      need(`${route} is declared more than once`);
    }
    seenRoutes.add(route);
  }
  if (typeof tag !== "string" || tag === "") {
    need("tag is required");
  }
  if (!includes(AUTH_POLICIES, auth)) {
    need(`x-slugbase-auth (auth) is required: one of ${AUTH_POLICIES.join(", ")}`);
  }
  if (!includes(RATE_BUCKETS, rate)) {
    need(`x-slugbase-rate (rate) is required: one of ${RATE_BUCKETS.join(", ")}`);
  }
  if (scope !== undefined && !includes(TOKEN_SCOPES, scope)) {
    need(`x-slugbase-scope (scope) must be one of ${TOKEN_SCOPES.join(", ")} when present`);
  }
  if (entitlement !== undefined && (typeof entitlement !== "string" || entitlement === "")) {
    need("x-slugbase-entitlement (entitlement) must be a non-empty string when present");
  }
  if (audience !== undefined && !includes(AUDIENCES, audience)) {
    need(`audience must be one of ${AUDIENCES.join(", ")} when present`);
  }

  if (request !== undefined && !isRecord(request)) {
    need("request must be an object");
  } else {
    for (const part of ["params", "query"] as const) {
      const schema = request?.[part];
      if (schema !== undefined && !(schema instanceof z.ZodObject)) {
        need(`request.${part} must be a Zod object schema`);
      }
    }
    const body = request?.["body"];
    if (body !== undefined && !(body instanceof z.ZodType)) {
      need("request.body must be a Zod schema");
    }
    if (typeof path === "string") {
      const declared = pathParameters(path).sort();
      const params = request?.["params"];
      const typed = params instanceof z.ZodObject ? Object.keys(params.shape).sort() : [];
      if (declared.join() !== typed.join()) {
        need(`path parameters {${declared.join(", ")}} do not match request.params (${typed.join(", ")})`);
      }
    }
  }

  if (!isRecord(responses)) {
    need("responses are required");
  } else {
    const entries = Object.entries(responses);
    let hasSuccess = false;
    let hasProblem = false;
    for (const [status, response] of entries) {
      const code = Number(status);
      if (!Number.isInteger(code)) {
        need(`response status ${status} is not a number`);
        continue;
      }
      const kind = isRecord(response) ? response["kind"] : undefined;
      if (kind !== "json" && kind !== "problem" && kind !== "empty") {
        need(`response ${status} must be built with jsonResponse, problemResponse or emptyResponse`);
        continue;
      }
      if (kind === "json" && !(isRecord(response) && response["schema"] instanceof z.ZodType)) {
        need(`response ${status} needs a Zod schema`);
      }
      const headers = isRecord(response) ? response["headers"] : undefined;
      if (headers !== undefined) {
        if (kind !== "json" || !isRecord(headers)) {
          need(`response ${status} headers must be an object on a jsonResponse`);
        } else {
          for (const [name, header] of Object.entries(headers)) {
            if (!/^[A-Za-z0-9-]+$/.test(name)) {
              need(`response ${status} header ${name} is not a valid header name`);
            }
            if (!isRecord(header) || typeof header["description"] !== "string" || !(header["schema"] instanceof z.ZodType)) {
              need(`response ${status} header ${name} needs a description and a Zod schema`);
            }
          }
        }
      }
      if (code < 400) {
        hasSuccess = true;
      }
      if (code >= 400 && code < 500) {
        if (kind === "problem") {
          hasProblem = true;
        } else {
          need(`response ${status} must be an application/problem+json response`);
        }
      }
    }
    if (!hasSuccess) {
      need("at least one success response (below 400) is required");
    }
    if (!hasProblem) {
      need("at least one 4xx application/problem+json response is required");
    }
  }
  return problems;
}

function buildOperation(op: OperationDefinition, converter: Converter): JsonObject {
  const entry: JsonObject = {
    operationId: op.operationId,
    tags: [op.tag],
    "x-slugbase-auth": op.auth,
    "x-slugbase-rate": op.rate,
  };
  if (op.summary !== undefined) {
    entry["summary"] = op.summary;
  }
  if (op.scope !== undefined) {
    entry["x-slugbase-scope"] = op.scope;
  }
  if (op.entitlement !== undefined) {
    entry["x-slugbase-entitlement"] = op.entitlement;
  }
  if (op.audience !== undefined) {
    entry["x-slugbase-audience"] = op.audience;
  }

  const parameters: JsonObject[] = [];
  if (op.request?.params !== undefined) {
    parameters.push(...objectParameters(converter, op.request.params, "path"));
  }
  if (op.request?.query !== undefined) {
    parameters.push(...objectParameters(converter, op.request.query, "query"));
  }
  if (parameters.length > 0) {
    entry["parameters"] = parameters;
  }

  if (op.request?.body !== undefined) {
    const schema = converter.convert(op.request.body, "input");
    if (schema !== undefined) {
      const open = openObjects(schema, converter.components, "body", new Set());
      if (open.length > 0) {
        converter.problems.push(
          `${converter.owner}: request body must use strict object schemas (z.strictObject), unknown fields are a 422; not strict: ${open.join(", ")}`,
        );
      }
      entry["requestBody"] = { required: true, content: { "application/json": { schema } } };
    }
  }

  const responses: JsonObject = {};
  for (const [status, response] of Object.entries(op.responses)) {
    if (response.kind === "json") {
      const schema = converter.convert(response.schema, "output");
      const built: JsonObject = {
        description: response.description,
        content: { "application/json": { schema: schema ?? {} } },
      };
      if (response.headers !== undefined) {
        const headers: JsonObject = {};
        for (const [name, header] of Object.entries(response.headers)) {
          headers[name] = {
            description: header.description,
            required: true,
            schema: converter.convert(header.schema, "output") ?? {},
          };
        }
        built["headers"] = headers;
      }
      responses[status] = built;
    } else if (response.kind === "problem") {
      responses[status] = {
        description: response.description,
        content: { "application/problem+json": { schema: { $ref: `${COMPONENT_PREFIX}Problem` } } },
      };
    } else {
      responses[status] = { description: response.description };
    }
  }
  entry["responses"] = responses;
  return entry;
}

/**
 * Builds the OpenAPI 3.1 document for a set of operations. Throws
 * OperationDeclarationError, naming each offending operation, when any
 * declaration is incomplete or breaks a contract rule; nothing partial is returned.
 */
export function buildOpenApiDocument(operations: readonly unknown[]): JsonObject {
  const seenIds = new Set<string>();
  const seenRoutes = new Set<string>();
  const declarationProblems = operations.flatMap((raw, index) => checkDeclaration(raw, index, seenIds, seenRoutes));
  if (declarationProblems.length > 0) {
    throw new OperationDeclarationError(declarationProblems);
  }

  const converter = new Converter();
  const paths: JsonObject = {};
  const tags = new Set<string>();

  converter.owner = "Problem";
  converter.convert(ProblemSchema, "output");

  (operations as readonly OperationDefinition[]).forEach((op, index) => {
    converter.owner = describeOperation(op, index);
    const item = (paths[op.path] ??= {}) as JsonObject;
    item[op.method] = buildOperation(op, converter);
    tags.add(op.tag);
  });

  if (converter.problems.length > 0) {
    throw new OperationDeclarationError(converter.problems);
  }

  const schemas: JsonObject = {};
  for (const [id, definition] of converter.components) {
    schemas[id] = definition;
  }
  return {
    openapi: "3.1.0",
    info: { title: "SlugBase API", version: "1", license: { name: "AGPL-3.0-only", identifier: "AGPL-3.0-only" } },
    tags: [...tags].sort().map((name) => ({ name })),
    paths,
    components: { schemas },
  };
}

/** The committed form of the document: sorted keys, two-space indent, trailing newline. */
export function serializeOpenApiDocument(document: JsonObject): string {
  return `${JSON.stringify(sortKeys(document), null, 2)}\n`;
}
