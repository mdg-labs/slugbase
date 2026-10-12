import type { OperationDefinition } from "@slugbase/contracts";
import { z } from "zod";
import { isRecord } from "./document.ts";

// An OpenAPI document for operations declared in a test, in the shape of the
// generated one for what the walker reads: the policy extensions, the parameters
// and request body the classifier reads, and the responses with their schemas.
// The shared Problem schemas come from the committed document. A test schema
// that needs a named component is refused: the test operations use inline ones.

function schemaOf(schema: z.ZodType, io: "input" | "output"): Record<string, unknown> {
  const generated = z.toJSONSchema(schema, { target: "draft-2020-12", io }) as Record<string, unknown>;
  if (generated["$defs"] !== undefined) {
    throw new Error("a test operation uses a named schema; declare its schemas inline");
  }
  delete generated["$schema"];
  return generated;
}

function parametersOf(schema: z.ZodObject, location: "path" | "query"): Record<string, unknown>[] {
  const { properties, required } = schemaOf(schema, "input");
  return Object.entries(isRecord(properties) ? properties : {}).map(([name, property]) => ({
    name,
    in: location,
    required: location === "path" || (Array.isArray(required) && required.includes(name)),
    schema: property,
  }));
}

function entryOf(operation: OperationDefinition): Record<string, unknown> {
  const parameters = [
    ...(operation.request?.params === undefined ? [] : parametersOf(operation.request.params, "path")),
    ...(operation.request?.query === undefined ? [] : parametersOf(operation.request.query, "query")),
  ];
  const responses = Object.fromEntries(
    Object.entries(operation.responses).map(([status, response]) => {
      if (response.kind === "json") {
        return [
          status,
          {
            description: response.description,
            content: { "application/json": { schema: schemaOf(response.schema, "output") } },
            ...(response.headers === undefined
              ? {}
              : {
                  headers: Object.fromEntries(
                    Object.entries(response.headers).map(([name, header]) => [
                      name,
                      { description: header.description, required: true, schema: schemaOf(header.schema, "output") },
                    ]),
                  ),
                }),
          },
        ];
      }
      if (response.kind === "problem") {
        return [status, { description: response.description, content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } } }];
      }
      return [status, { description: response.description }];
    }),
  );
  return {
    operationId: operation.operationId,
    tags: [operation.tag],
    "x-slugbase-auth": operation.auth,
    "x-slugbase-rate": operation.rate,
    ...(operation.scope === undefined ? {} : { "x-slugbase-scope": operation.scope }),
    ...(operation.entitlement === undefined ? {} : { "x-slugbase-entitlement": operation.entitlement }),
    ...(operation.audience === undefined ? {} : { "x-slugbase-audience": operation.audience }),
    ...(parameters.length === 0 ? {} : { parameters }),
    ...(operation.request?.body === undefined
      ? {}
      : { requestBody: { required: true, content: { "application/json": { schema: schemaOf(operation.request.body, "input") } } } }),
    responses,
  };
}

export interface TestDocument {
  readonly paths: Record<string, Record<string, unknown>>;
  readonly [member: string]: unknown;
}

/** The document of `operations`; `committed` is the committed document, whose Problem schemas it reuses. */
export function buildDocument(operations: readonly OperationDefinition[], committed: unknown): TestDocument {
  const components = isRecord(committed) && isRecord(committed["components"]) ? committed["components"] : {};
  const paths: Record<string, Record<string, unknown>> = {};
  for (const operation of operations) {
    (paths[operation.path] ??= {})[operation.method] = entryOf(operation);
  }
  return { openapi: "3.1.0", info: { title: "SlugBase API (test)", version: "1" }, paths, components };
}
