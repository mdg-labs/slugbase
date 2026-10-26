import { dereference, isRecord, type OpenApiDocument } from "./document.js";

// Deterministic values built from a JSON Schema: the same schema always yields
// the same value, and the value satisfies the schema's types, enums, constants,
// bounds and formats. A keyword the generator cannot satisfy (a `pattern`) is
// not guessed at: the generated body then fails the schema check of the tests,
// and the operation gets a fixture override.

const STRING_BY_FORMAT: Readonly<Record<string, string>> = {
  uri: "https://example.com/",
  "uri-reference": "/example",
  url: "https://example.com/",
  "date-time": "2026-01-01T00:00:00Z",
  date: "2026-01-01",
  time: "00:00:00Z",
  email: "user@example.com",
  uuid: "0192f3a0-0000-7000-8000-000000000000",
  ipv4: "192.0.2.1",
  ipv6: "2001:db8::1",
  hostname: "example.com",
};

const CYCLE = Symbol("cycle");

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function firstAlternative(document: OpenApiDocument, alternatives: readonly unknown[]): unknown {
  const resolved = alternatives.map((alternative) => dereference(document, alternative));
  return resolved.find((alternative) => !(isRecord(alternative) && alternative.type === "null")) ?? resolved[0];
}

function stringOf(schema: Readonly<Record<string, unknown>>): string {
  const format = typeof schema.format === "string" ? schema.format : undefined;
  let value = (format === undefined ? undefined : STRING_BY_FORMAT[format]) ?? "string";
  const minLength = numberOf(schema.minLength);
  if (minLength !== undefined && value.length < minLength) {
    value = value.padEnd(minLength, "x");
  }
  const maxLength = numberOf(schema.maxLength);
  return maxLength !== undefined && value.length > maxLength ? value.slice(0, maxLength) : value;
}

function numberFrom(schema: Readonly<Record<string, unknown>>, integer: boolean): number {
  const exclusiveMinimum = numberOf(schema.exclusiveMinimum);
  const minimum = numberOf(schema.minimum) ?? (exclusiveMinimum === undefined ? 0 : exclusiveMinimum + 1);
  const maximum = numberOf(schema.maximum);
  const value = maximum !== undefined && minimum > maximum ? maximum : minimum;
  return integer ? Math.ceil(value) : value;
}

/** The property that names the next page of a list; the contract says it is null on the last page. */
const NEXT_PAGE_PROPERTY = "nextCursor";

function allowsNull(document: OpenApiDocument, value: unknown): boolean {
  const schema = dereference(document, value);
  return isRecord(schema) && Array.isArray(schema.type) && schema.type.includes("null");
}

function generateObject(document: OpenApiDocument, schema: Readonly<Record<string, unknown>>, stack: readonly string[]): unknown {
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((key) => typeof key === "string") : []);
  const result: Record<string, unknown> = {};
  if (isRecord(schema.properties)) {
    for (const [name, property] of Object.entries(schema.properties)) {
      // A generated list is one page and the last: a cursor to a further page would send a reader that follows it to the
      // end (the sidebar's folders) through pages that never stop. A scenario that needs a next page sets its own fixture.
      if (name === NEXT_PAGE_PROPERTY && allowsNull(document, property)) {
        result[name] = null;
        continue;
      }
      const value = generate(document, property, stack);
      if (value === CYCLE) {
        if (required.has(name)) {
          throw new Error(`Property ${name} is required and refers back to its own schema`);
        }
        continue;
      }
      result[name] = value;
    }
  }
  return result;
}

function generateArray(document: OpenApiDocument, schema: Readonly<Record<string, unknown>>, stack: readonly string[]): unknown {
  const count = Math.max(numberOf(schema.minItems) ?? 1, 0);
  const item = generate(document, schema.items ?? {}, stack);
  return item === CYCLE ? [] : Array.from({ length: count }, () => structuredClone(item));
}

function typeOf(schema: Readonly<Record<string, unknown>>): unknown {
  const declared: unknown = Array.isArray(schema.type)
    ? ((schema.type as unknown[]).find((type) => type !== "null") ?? "null")
    : schema.type;
  if (declared !== undefined) {
    return declared;
  }
  if (schema.properties !== undefined) {
    return "object";
  }
  return schema.items === undefined ? undefined : "array";
}

function generate(document: OpenApiDocument, value: unknown, stack: readonly string[]): unknown {
  let reference: string | undefined;
  if (isRecord(value) && typeof value.$ref === "string") {
    reference = value.$ref;
    if (stack.includes(reference)) {
      return CYCLE;
    }
  }
  const next = reference === undefined ? stack : [...stack, reference];
  const schema = dereference(document, value);
  if (!isRecord(schema)) {
    return {};
  }
  if (schema.const !== undefined) {
    return schema.const;
  }
  if (Array.isArray(schema.examples) && schema.examples.length > 0) {
    return schema.examples[0];
  }
  if (schema.example !== undefined) {
    return schema.example;
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum[0];
  }
  if (Array.isArray(schema.allOf)) {
    const parts = schema.allOf.map((part) => generate(document, part, next));
    return Object.assign({}, ...parts.filter(isRecord)) as unknown;
  }
  for (const key of ["anyOf", "oneOf"] as const) {
    const alternatives = schema[key];
    if (Array.isArray(alternatives) && alternatives.length > 0) {
      return generate(document, firstAlternative(document, alternatives), next);
    }
  }
  const type = typeOf(schema);
  switch (type) {
    case "string":
      return stringOf(schema);
    case "integer":
    case "number":
      return numberFrom(schema, type === "integer");
    case "boolean":
      return false;
    case "null":
      return null;
    case "array":
      return generateArray(document, schema, next);
    case "object":
      return generateObject(document, schema, next);
    default:
      return {};
  }
}

/** The deterministic value of a schema of the document; `$ref` is followed inside the document. */
export function fixtureFor(document: OpenApiDocument, schema: unknown): unknown {
  const value = generate(document, schema, []);
  if (value === CYCLE) {
    throw new Error("The schema refers back to itself with nothing to stop at");
  }
  return value;
}
