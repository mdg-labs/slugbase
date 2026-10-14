/// <reference types="node" />
import { readFileSync } from "node:fs";

// The operations of openapi.json, classified for the cross-tenant matrix. The
// policy of an operation is the x-slugbase-auth extension (doc 04 section 1.2):
// member, admin and owner operations act inside one workspace; account and
// partial operations act on the signed-in account; anonymous operations need no
// session; instanceAdmin and machine operations belong to the process, not to
// a workspace.

export const OPERATION_KINDS = ["tenant-scoped", "account-level", "anonymous", "process"] as const;
export type OperationKind = (typeof OPERATION_KINDS)[number];

const KIND_OF_POLICY: Readonly<Record<string, OperationKind>> = {
  member: "tenant-scoped",
  admin: "tenant-scoped",
  owner: "tenant-scoped",
  account: "account-level",
  // A session whose second factor is pending is still the signed-in account.
  partial: "account-level",
  anonymous: "anonymous",
  instanceAdmin: "process",
  machine: "process",
};

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

/** Where in a request an input is carried. A path parameter is not listed here: it comes from the path template. */
export type InputLocation = "query" | "body";

/** An input of a tenant-scoped operation that can carry the identifier of a row. */
export interface IdentifierInput {
  readonly location: InputLocation;
  /**
   * The key the mapping file uses for the input, and how a failure names it:
   * the parameter name for a query parameter, the property path for a body
   * (`accountId`, `invitation.teamIds[]`), with `[]` for an array item.
   */
  readonly name: string;
  /** The property names from the root of the query or body to the input; `[]` stands for an array item. */
  readonly segments: readonly string[];
}

export interface ClassifiedOperation {
  readonly operationId: string;
  readonly method: string;
  /** The path template, such as `/api/v1/bookmarks/{bookmarkId}`. */
  readonly path: string;
  readonly policy: string;
  readonly kind: OperationKind;
  /** The path parameters of the template, in order. */
  readonly pathParameters: readonly string[];
  /**
   * The query and body inputs of a tenant-scoped operation that can carry an
   * identifier; always empty for any other kind. The rule is in `collectInputs`.
   */
  readonly inputs: readonly IdentifierInput[];
  /**
   * What of the operation's query and request body could not be walked, so
   * that it cannot be said which identifiers it takes. Each entry fails the
   * matrix: an input that is not understood is not a safe one.
   */
  readonly unwalkable: readonly string[];
}

export interface ClassificationSummary {
  readonly total: number;
  readonly byKind: Readonly<Record<OperationKind, number>>;
}

export interface Classification {
  readonly operations: readonly ClassifiedOperation[];
  /** Operations the classifier could not place; each one fails the matrix. */
  readonly problems: readonly { readonly subject: string; readonly detail: string }[];
  readonly summary: ClassificationSummary;
}

export function describeOperation(operation: Pick<ClassifiedOperation, "operationId" | "method" | "path">): string {
  return `${operation.operationId} (${operation.method.toUpperCase()} ${operation.path})`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function templateParameters(path: string): string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1] ?? "");
}

// The identifier-carrying inputs of an operation (D11: the workspace is never in
// the path, so an identifier of B reaches an operation through its path
// parameters, its query or its request body). A scalar input carries an
// identifier when its schema is `format: uuid`, or when its property or
// parameter name is `id`, `slug` or ends in `Id`, `Ids`, `Slug` or `Slugs`
// (so `teamIds: string[]` and `accountId` both count). The rule over-selects on
// purpose: an input that is picked without being an identifier has to be mapped
// to a kind of identifier like the others, and one that is missed would go
// untargeted. An operation whose query or body schema cannot be walked (an
// unresolved reference, a free-form object, a schema that accepts anything, a
// body without a schema) is reported in `unwalkable` instead of being skipped.

const IDENTIFIER_NAME = /^(id|ids|slug|slugs)$|(Id|Ids|Slug|Slugs)$/;
const MAX_SCHEMA_DEPTH = 24;
const SCALAR_TYPES = ["string", "number", "integer", "boolean", "null"];

// The schema keywords the walk understands. Those it handles are listed first;
// the rest only annotate the schema or constrain a value without changing which
// properties or items exist, or where an identifier can sit. Any other keyword
// (propertyNames, patternProperties, prefixItems, contains, if/then/else, not,
// dependentSchemas, unevaluatedProperties, unevaluatedItems, ...) is an
// applicator the walk does not follow, so a schema carrying one is reported in
// `unwalkable` instead of being read as if the keyword were absent. An
// extension keyword (`x-...`) is an annotation. The keywords beside a `$ref`
// are walked as a schema of their own, together with the referenced one (also
// when that reference is already on the path, where only the target is not
// walked again). The keyword lists and the identifier rule apply to them as to
// any schema. They are walked as a refinement of the target, which skips the
// reports for a free-form object, an array without items and a schema that
// accepts anything, because the target was already walked; an alternative
// reference form (`$dynamicRef`, `$recursiveRef`, `$anchor`) is not in the
// lists and is reported.
const WALKED_KEYWORDS = [
  "$ref", "allOf", "anyOf", "oneOf", "type", "properties", "additionalProperties", "items", "const", "enum", "format",
];
const IGNORED_KEYWORDS = [
  // annotations
  "$schema", "$id", "id", "$comment", "$defs", "definitions", "title", "description", "default", "example", "examples",
  "deprecated", "readOnly", "writeOnly", "externalDocs", "xml", "discriminator",
  // validation of a value, or of the size or required names of the structure the walk has already read
  "nullable", "required", "pattern", "minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
  "multipleOf", "minItems", "maxItems", "uniqueItems", "minProperties", "maxProperties", "contentEncoding", "contentMediaType",
];
const UNDERSTOOD_KEYWORDS = new Set<string>([...WALKED_KEYWORDS, ...IGNORED_KEYWORDS]);

interface Collected {
  readonly inputs: IdentifierInput[];
  readonly unwalkable: string[];
}

function inputName(segments: readonly string[]): string {
  let name = "";
  for (const segment of segments) {
    if (segment === "[]") {
      name += "[]";
    } else {
      name += name === "" ? segment : `.${segment}`;
    }
  }
  return name;
}

/** Follows a `$ref` into the same document, or answers undefined. */
function resolveReference(document: unknown, reference: string): Record<string, unknown> | undefined {
  if (!reference.startsWith("#/")) {
    return undefined;
  }
  let current: unknown = document;
  for (const raw of reference.slice(2).split("/")) {
    const key = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isRecord(current) || !(key in current)) {
      return undefined;
    }
    current = current[key];
  }
  return isRecord(current) ? current : undefined;
}

function typesOf(schema: Record<string, unknown>): string[] {
  const type = schema["type"];
  if (typeof type === "string") {
    return [type];
  }
  return Array.isArray(type) ? type.filter((entry): entry is string => typeof entry === "string") : [];
}

function lastName(segments: readonly string[]): string {
  return [...segments].reverse().find((segment) => segment !== "[]") ?? "";
}

function walkSchema(
  document: unknown,
  schema: unknown,
  segments: readonly string[],
  location: InputLocation,
  out: Collected,
  references: readonly string[],
  where: string,
  refinement = false,
): void {
  const here = inputName(segments);
  const unwalkable = (reason: string): void => {
    out.unwalkable.push(`${where}${here === "" ? "" : ` "${here}"`}: ${reason}`);
  };
  if (!isRecord(schema) || references.length > MAX_SCHEMA_DEPTH) {
    unwalkable("the schema is not an object or is nested too deeply to walk");
    return;
  }

  if ("$ref" in schema) {
    const reference = schema["$ref"];
    if (typeof reference !== "string") {
      unwalkable("its $ref is not a string");
      return;
    }
    // A target already on the current path of references is not walked again (its
    // inputs were met on the way in); the keywords beside the `$ref` are considered
    // either way, as they are not part of the target.
    if (!references.includes(reference)) {
      const target = resolveReference(document, reference);
      if (target === undefined) {
        unwalkable(`the reference ${reference} cannot be resolved`);
        return;
      }
      walkSchema(document, target, segments, location, out, [...references, reference], where);
    }
    // Keywords beside a $ref apply as well (JSON Schema 2020-12), so the schema
    // is the target and its siblings together: walk the siblings as a node of
    // their own, under the same keyword lists and identifier rule, as a refinement
    // of the target (so the free-form-object, array-without-items and
    // accepts-anything reports, which the target walk already made, are skipped),
    // unless every sibling is a keyword in `IGNORED_KEYWORDS` or an `x-` extension.
    // They are given the path that led to this node, which holds the reference
    // they sit beside only when that reference closed a cycle: a `$ref` inside
    // them is walked unless its component is already on that path.
    // The path of references bounds the depth of the walk, so this terminates.
    const siblings = Object.fromEntries(Object.entries(schema).filter(([keyword]) => keyword !== "$ref"));
    if (Object.keys(siblings).some((keyword) => !IGNORED_KEYWORDS.includes(keyword) && !keyword.startsWith("x-"))) {
      const beside: Collected = { inputs: [], unwalkable: [] };
      walkSchema(document, siblings, segments, location, beside, references, where, true);
      out.unwalkable.push(...beside.unwalkable);
      for (const input of beside.inputs) {
        if (!out.inputs.some((known) => known.location === input.location && known.name === input.name)) {
          out.inputs.push(input);
        }
      }
    }
    return;
  }

  const unknown = Object.keys(schema).filter((keyword) => !UNDERSTOOD_KEYWORDS.has(keyword) && !keyword.startsWith("x-"));
  if (unknown.length > 0) {
    unwalkable(`it uses ${unknown.map((keyword) => `"${keyword}"`).join(", ")}, which the walk does not follow`);
  }

  let understood = false;
  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    const branches = schema[keyword];
    if (Array.isArray(branches)) {
      understood = true;
      for (const branch of branches) {
        walkSchema(document, branch, segments, location, out, references, where);
      }
    }
  }

  const types = typesOf(schema);
  const properties = schema["properties"];
  if (types.includes("object") || isRecord(properties)) {
    understood = true;
    const additional = schema["additionalProperties"];
    if (isRecord(properties)) {
      for (const [key, property] of Object.entries(properties)) {
        walkSchema(document, property, [...segments, key], location, out, references, where);
      }
    }
    if (!refinement && (additional === true || (additional === undefined && !isRecord(properties)))) {
      unwalkable("a free-form object can carry any property");
    } else if (isRecord(additional)) {
      const probe: Collected = { inputs: [], unwalkable: [] };
      walkSchema(document, additional, [...segments, "*"], location, probe, references, where);
      if (probe.inputs.length > 0 || probe.unwalkable.length > 0) {
        unwalkable("a map with arbitrary keys can carry an identifier under any of them");
      }
    }
  }

  if (types.includes("array") || "items" in schema) {
    understood = true;
    if ("items" in schema) {
      walkSchema(document, schema["items"], [...segments, "[]"], location, out, references, where);
    } else if (!refinement) {
      unwalkable("an array without an items schema can carry anything");
    }
  }

  const scalar =
    types.some((type) => SCALAR_TYPES.includes(type)) ||
    "const" in schema ||
    "enum" in schema ||
    typeof schema["format"] === "string";
  if (scalar) {
    understood = true;
    if (schema["format"] === "uuid" || IDENTIFIER_NAME.test(lastName(segments))) {
      out.inputs.push({ location, name: here === "" ? "(body)" : here, segments });
    }
  }

  if (!understood && !refinement) {
    unwalkable("the schema accepts anything");
  }
}

function mergeParameters(
  document: unknown,
  ...lists: readonly unknown[]
): { parameters: Record<string, unknown>[]; problems: string[] } {
  const merged = new Map<string, Record<string, unknown>>();
  const problems: string[] = [];
  for (const list of lists) {
    if (list === undefined) {
      continue;
    }
    if (!Array.isArray(list)) {
      problems.push("parameters: not a list");
      continue;
    }
    for (const entry of list) {
      const parameter: unknown =
        isRecord(entry) && typeof entry["$ref"] === "string" ? resolveReference(document, entry["$ref"]) : entry;
      if (!isRecord(parameter) || typeof parameter["name"] !== "string" || typeof parameter["in"] !== "string") {
        problems.push("parameters: a parameter cannot be read (not an object with name and in, or an unresolved reference)");
        continue;
      }
      merged.set(`${parameter["in"]}:${parameter["name"]}`, parameter);
    }
  }
  return { parameters: [...merged.values()], problems };
}

/** The identifier-carrying query and body inputs of one operation. */
function collectInputs(document: unknown, pathItem: Record<string, unknown>, operation: Record<string, unknown>): Collected {
  const out: Collected = { inputs: [], unwalkable: [] };

  const { parameters, problems } = mergeParameters(document, pathItem["parameters"], operation["parameters"]);
  out.unwalkable.push(...problems);
  for (const parameter of parameters) {
    if (parameter["in"] !== "query") {
      continue;
    }
    const name = String(parameter["name"]);
    const where = "query parameter";
    if (!("schema" in parameter)) {
      out.unwalkable.push(`${where} "${name}": it has no schema`);
      continue;
    }
    const found: Collected = { inputs: [], unwalkable: [] };
    walkSchema(document, parameter["schema"], [name], "query", found, [], where);
    out.unwalkable.push(...found.unwalkable);
    for (const input of found.inputs) {
      // A query value is a string or a repeated string; a nested object has no place in it.
      const nested = input.segments.length > 1 && !(input.segments.length === 2 && input.segments[1] === "[]");
      if (nested) {
        out.unwalkable.push(`${where} "${input.name}": a nested query value cannot be placed in a query string`);
      } else {
        out.inputs.push(input);
      }
    }
  }

  let body = operation["requestBody"];
  if (body === undefined) {
    return out;
  }
  if (isRecord(body) && typeof body["$ref"] === "string") {
    body = resolveReference(document, body["$ref"]);
  }
  const content = isRecord(body) ? body["content"] : undefined;
  if (!isRecord(content) || Object.keys(content).length === 0) {
    out.unwalkable.push("request body: it has no content to walk");
    return out;
  }
  const seen = new Set<string>();
  for (const [mediaType, media] of Object.entries(content)) {
    const where = `request body (${mediaType})`;
    if (!isRecord(media) || !("schema" in media)) {
      out.unwalkable.push(`${where}: it has no schema`);
      continue;
    }
    const found: Collected = { inputs: [], unwalkable: [] };
    walkSchema(document, media["schema"], [], "body", found, [], where);
    out.unwalkable.push(...found.unwalkable);
    for (const input of found.inputs) {
      const key = `${input.location}:${input.name}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.inputs.push(input);
      }
    }
  }
  return out;
}

/**
 * Classifies every operation of an OpenAPI document. An operation without an
 * operationId or with a missing or unknown policy is reported as a problem and
 * left out of the operations: nothing is assumed safe.
 */
export function classifyOperations(document: unknown): Classification {
  const operations: ClassifiedOperation[] = [];
  const problems: { subject: string; detail: string }[] = [];
  const paths = isRecord(document) ? document["paths"] : undefined;
  if (!isRecord(paths)) {
    return {
      operations,
      problems: [{ subject: "document", detail: "the OpenAPI document has no paths object" }],
      summary: summarize(operations, 0),
    };
  }

  let unclassified = 0;
  for (const [path, item] of Object.entries(paths)) {
    if (!isRecord(item)) {
      unclassified += 1;
      problems.push({ subject: path, detail: "the path item is not an object" });
      continue;
    }
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (operation === undefined) {
        continue;
      }
      const subject = `${method.toUpperCase()} ${path}`;
      if (!isRecord(operation)) {
        unclassified += 1;
        problems.push({ subject, detail: "the operation is not an object" });
        continue;
      }
      const operationId = operation["operationId"];
      if (typeof operationId !== "string" || operationId === "") {
        unclassified += 1;
        problems.push({ subject, detail: "the operation has no operationId" });
        continue;
      }
      const policy = operation["x-slugbase-auth"];
      const kind = typeof policy === "string" ? KIND_OF_POLICY[policy] : undefined;
      if (typeof policy !== "string" || kind === undefined) {
        unclassified += 1;
        problems.push({
          subject: `${operationId} (${subject})`,
          detail: `the operation has no known x-slugbase-auth policy (found ${policy === undefined ? "none" : JSON.stringify(policy)})`,
        });
        continue;
      }
      const collected = kind === "tenant-scoped" ? collectInputs(document, item, operation) : { inputs: [], unwalkable: [] };
      operations.push({
        operationId,
        method,
        path,
        policy,
        kind,
        pathParameters: templateParameters(path),
        inputs: collected.inputs,
        unwalkable: collected.unwalkable,
      });
    }
  }
  return { operations, problems, summary: summarize(operations, unclassified) };
}

function summarize(operations: readonly ClassifiedOperation[], unclassified: number): ClassificationSummary {
  const byKind: Record<OperationKind, number> = { "tenant-scoped": 0, "account-level": 0, anonymous: 0, process: 0 };
  for (const operation of operations) {
    byKind[operation.kind] += 1;
  }
  return { total: operations.length + unclassified, byKind };
}

// packages/testing/{src,dist}/tenancy/ -> packages/contracts/generated/openapi.json
const COMMITTED_DOCUMENT = new URL("../../../contracts/generated/openapi.json", import.meta.url);

/** Reads the committed OpenAPI document of packages/contracts. */
export function loadOpenApiDocument(): unknown {
  return JSON.parse(readFileSync(COMMITTED_DOCUMENT, "utf8")) as unknown;
}
