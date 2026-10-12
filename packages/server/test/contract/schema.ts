// A validator for the JSON Schema subset the generated OpenAPI document uses.
// The walker checks responses with it rather than with the Zod schemas the
// server validates with, so that the document is what is tested. It fails
// closed: a keyword or format it does not understand is an issue, never
// skipped, because a schema that is not read is a response that is not checked.

export interface SchemaIssue {
  /** Where in the value the issue is, as dotted property names and `[index]`. */
  readonly path: string;
  readonly message: string;
}

export type ResolveReference = (reference: string) => unknown;

const MAX_DEPTH = 32;

const ANNOTATIONS = new Set([
  "$schema", "$id", "$comment", "$defs", "title", "description", "default", "example", "examples", "deprecated", "readOnly", "writeOnly", "externalDocs",
]);
const KEYWORDS = new Set([
  "$ref", "type", "enum", "const", "format", "properties", "required", "additionalProperties", "items", "minItems", "maxItems", "uniqueItems",
  "minLength", "maxLength", "pattern", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "allOf", "anyOf", "oneOf",
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const FORMATS: Readonly<Record<string, (value: string) => boolean>> = {
  uri: (value) => URL.canParse(value),
  uuid: (value) => UUID.test(value),
  "date-time": (value) => DATE_TIME.test(value) && !Number.isNaN(Date.parse(value)),
  date: (value) => DATE.test(value) && !Number.isNaN(Date.parse(value)),
  email: (value) => EMAIL.test(value),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeOf(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value === "number" && Number.isInteger(value) ? "integer" : typeof value;
}

function isType(value: unknown, type: unknown): boolean {
  const actual = typeOf(value);
  return type === actual || (type === "number" && actual === "integer");
}

function same(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => same(item, b[index]));
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && same(a[key], b[key]));
  }
  return a === b;
}

function at(path: string, key: string | number): string {
  return typeof key === "number" ? `${path}[${String(key)}]` : path === "" ? key : `${path}.${key}`;
}

function check(
  schema: unknown,
  value: unknown,
  path: string,
  resolve: ResolveReference,
  depth: number,
  issues: SchemaIssue[],
): void {
  const issue = (message: string): void => {
    issues.push({ path, message });
  };
  if (depth > MAX_DEPTH) {
    issue("the schema is nested deeper than the validator reads");
    return;
  }
  if (schema === true) {
    return;
  }
  if (!isRecord(schema)) {
    issue("the schema is not an object");
    return;
  }
  for (const keyword of Object.keys(schema)) {
    if (!KEYWORDS.has(keyword) && !ANNOTATIONS.has(keyword) && !keyword.startsWith("x-")) {
      issue(`the schema uses the keyword "${keyword}", which the validator does not read`);
      return;
    }
  }

  const reference = schema["$ref"];
  if (typeof reference === "string") {
    const target = resolve(reference);
    if (target === undefined) {
      issue(`the reference ${reference} does not resolve`);
      return;
    }
    check(target, value, path, resolve, depth + 1, issues);
  }

  const type = schema["type"];
  if (type !== undefined) {
    const types: unknown[] = Array.isArray(type) ? type : [type];
    if (!types.some((candidate) => isType(value, candidate))) {
      issue(`expected ${types.join(" or ")}, got ${typeOf(value)}`);
      return;
    }
  }
  if (schema["const"] !== undefined && !same(schema["const"], value)) {
    issue(`expected the constant ${JSON.stringify(schema["const"])}`);
  }
  const options = schema["enum"];
  if (Array.isArray(options) && !options.some((option) => same(option, value))) {
    issue("not one of the declared values");
  }

  for (const [keyword, mode] of [["allOf", "all"], ["anyOf", "any"], ["oneOf", "one"]] as const) {
    const alternatives = schema[keyword];
    if (alternatives === undefined) {
      continue;
    }
    if (!Array.isArray(alternatives)) {
      issue(`${keyword} is not a list`);
      continue;
    }
    const outcomes = alternatives.map((alternative) => {
      const found: SchemaIssue[] = [];
      check(alternative, value, path, resolve, depth + 1, found);
      return found;
    });
    const matching = outcomes.filter((found) => found.length === 0).length;
    if (mode === "all") {
      issues.push(...outcomes.flat());
    } else if (mode === "any" ? matching === 0 : matching !== 1) {
      issue(mode === "any" ? "matches none of the alternatives" : `matches ${String(matching)} of the alternatives, expected exactly one`);
    }
  }

  if (typeof value === "string") {
    const { minLength, maxLength, pattern, format } = schema;
    if (typeof minLength === "number" && Array.from(value).length < minLength) {
      issue(`shorter than ${String(minLength)} characters`);
    }
    if (typeof maxLength === "number" && Array.from(value).length > maxLength) {
      issue(`longer than ${String(maxLength)} characters`);
    }
    if (typeof pattern === "string" && !new RegExp(pattern, "u").test(value)) {
      issue(`does not match the pattern ${pattern}`);
    }
    if (typeof format === "string") {
      const valid = FORMATS[format];
      if (valid === undefined) {
        issue(`the format "${format}" is not one the validator reads`);
      } else if (!valid(value)) {
        issue(`not a valid ${format}`);
      }
    }
  }

  if (typeof value === "number") {
    const { minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf } = schema;
    if (typeof minimum === "number" && value < minimum) {
      issue(`below the minimum ${String(minimum)}`);
    }
    if (typeof maximum === "number" && value > maximum) {
      issue(`above the maximum ${String(maximum)}`);
    }
    if (typeof exclusiveMinimum === "number" && value <= exclusiveMinimum) {
      issue(`not above ${String(exclusiveMinimum)}`);
    }
    if (typeof exclusiveMaximum === "number" && value >= exclusiveMaximum) {
      issue(`not below ${String(exclusiveMaximum)}`);
    }
    if (typeof multipleOf === "number" && value % multipleOf !== 0) {
      issue(`not a multiple of ${String(multipleOf)}`);
    }
  }

  if (Array.isArray(value)) {
    const { minItems, maxItems, uniqueItems, items } = schema;
    if (typeof minItems === "number" && value.length < minItems) {
      issue(`fewer than ${String(minItems)} items`);
    }
    if (typeof maxItems === "number" && value.length > maxItems) {
      issue(`more than ${String(maxItems)} items`);
    }
    if (uniqueItems === true && value.some((item, index) => value.findIndex((other) => same(item, other)) !== index)) {
      issue("items are not unique");
    }
    if (items !== undefined) {
      value.forEach((item, index) => {
        check(items, item, at(path, index), resolve, depth + 1, issues);
      });
    }
  }

  if (isRecord(value)) {
    const { properties, required, additionalProperties } = schema;
    const declared = isRecord(properties) ? properties : {};
    if (Array.isArray(required)) {
      for (const name of required) {
        if (typeof name === "string" && !Object.hasOwn(value, name)) {
          issues.push({ path: at(path, name), message: "required but absent" });
        }
      }
    }
    for (const [name, member] of Object.entries(value)) {
      if (Object.hasOwn(declared, name)) {
        check(declared[name], member, at(path, name), resolve, depth + 1, issues);
      } else if (additionalProperties === false) {
        issues.push({ path: at(path, name), message: "not a declared property" });
      } else if (additionalProperties !== undefined) {
        check(additionalProperties, member, at(path, name), resolve, depth + 1, issues);
      }
    }
  }
}

/** Every way `value` does not satisfy `schema`; empty when it does. */
export function validateSchema(schema: unknown, value: unknown, resolve: ResolveReference): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  check(schema, value, "", resolve, 0, issues);
  return issues;
}

/** Resolves `#/components/schemas/<name>` in an OpenAPI document. */
export function componentResolver(document: unknown): ResolveReference {
  const prefix = "#/components/schemas/";
  const components = isRecord(document) && isRecord(document["components"]) ? document["components"] : {};
  const schemas = isRecord(components["schemas"]) ? components["schemas"] : {};
  return (reference) => {
    const name = reference.slice(prefix.length);
    return reference.startsWith(prefix) && Object.hasOwn(schemas, name) ? schemas[name] : undefined;
  };
}
