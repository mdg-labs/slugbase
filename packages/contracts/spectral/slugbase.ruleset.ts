import type { IFunctionResult, RulesetDefinition, RulesetFunction } from "@stoplight/spectral-core";
import { truthy } from "@stoplight/spectral-functions";

/** The SlugBase ruleset of doc 04 section 1.1. Every rule is an error. */

const OPERATIONS = "$.paths[*][get,put,post,delete,options,head,patch,trace]";
const COMPONENT_SCHEMAS = "#/components/schemas/";
const PROBLEM_MEDIA_TYPE = "application/problem+json";

type JsonPath = (string | number)[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const tagged: RulesetFunction = (tags, _options, context) =>
  Array.isArray(tags) && tags.length > 0 ? undefined : [{ message: "Operation must declare at least one tag", path: [...context.path, "tags"] }];

/** Needs a 4xx response whose content has `application/problem+json`. Runs on the resolved document, so a `$ref`ed response counts. */
const problemResponse: RulesetFunction = (operation, _options, context) => {
  const responses = isRecord(operation) ? operation["responses"] : undefined;
  const found =
    isRecord(responses) &&
    Object.entries(responses).some(
      ([status, response]) =>
        /^4\d\d$/.test(status) && isRecord(response) && isRecord(response["content"]) && PROBLEM_MEDIA_TYPE in response["content"],
    );
  return found ? undefined : [{ message: "Operation must declare at least one 4xx response with application/problem+json", path: context.path }];
};

/** Where a response body schema is an object written out in place instead of a named component. */
function anonymousObjects(schema: unknown, path: JsonPath): IFunctionResult[] {
  if (!isRecord(schema)) {
    return [];
  }
  const ref = schema["$ref"];
  if (ref !== undefined) {
    return typeof ref === "string" && ref.startsWith(COMPONENT_SCHEMAS)
      ? []
      : [{ message: `Response schema must reference a named component under ${COMPONENT_SCHEMAS}`, path: [...path, "$ref"] }];
  }
  const type = schema["type"];
  const isObject =
    type === "object" ||
    (Array.isArray(type) && type.includes("object")) ||
    schema["properties"] !== undefined ||
    schema["additionalProperties"] !== undefined ||
    schema["patternProperties"] !== undefined;
  if (isObject) {
    return [{ message: "Response schema is an inline object; declare it as a named component and reference it", path }];
  }
  const found: IFunctionResult[] = [];
  found.push(...anonymousObjects(schema["items"], [...path, "items"]));
  for (const keyword of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
    const members = schema[keyword];
    if (Array.isArray(members)) {
      members.forEach((member, index) => found.push(...anonymousObjects(member, [...path, keyword, index])));
    }
  }
  return found;
}

/** Runs on the unresolved document: once `$ref`s are resolved a named component is indistinguishable from an inline schema. */
const namedResponseSchemas: RulesetFunction = (response, _options, context) => {
  let body: unknown = response;
  let base: JsonPath = context.path;
  if (isRecord(response) && typeof response["$ref"] === "string") {
    const pointer = response["$ref"];
    const target = pointer.startsWith("#/") ? pointer.slice(2).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~")) : [];
    let node: unknown = context.document.data;
    for (const part of target) {
      node = isRecord(node) ? node[part] : undefined;
    }
    if (node === undefined) {
      return [{ message: `Response reference ${pointer} does not resolve inside the document`, path: [...context.path, "$ref"] }];
    }
    body = node;
    base = target;
  }
  const content = isRecord(body) ? body["content"] : undefined;
  if (!isRecord(content)) {
    return undefined;
  }
  return Object.entries(content).flatMap(([mediaType, media]) =>
    isRecord(media) && media["schema"] !== undefined ? anonymousObjects(media["schema"], [...base, "content", mediaType, "schema"]) : [],
  );
};

export const ruleset = {
  rules: {
    "slugbase-operation-id": {
      description: "Every operation has an operationId",
      message: "Operation must declare an operationId",
      severity: "error",
      given: OPERATIONS,
      then: { field: "operationId", function: truthy },
    },
    "slugbase-operation-tag": {
      description: "Every operation has a tag",
      message: "{{error}}",
      severity: "error",
      given: OPERATIONS,
      then: { field: "tags", function: tagged },
    },
    "slugbase-operation-auth": {
      description: "Every operation declares x-slugbase-auth",
      message: "Operation must declare x-slugbase-auth",
      severity: "error",
      given: OPERATIONS,
      then: { field: "x-slugbase-auth", function: truthy },
    },
    "slugbase-operation-rate": {
      description: "Every operation declares x-slugbase-rate",
      message: "Operation must declare x-slugbase-rate",
      severity: "error",
      given: OPERATIONS,
      then: { field: "x-slugbase-rate", function: truthy },
    },
    "slugbase-problem-response": {
      description: "Every operation declares a 4xx application/problem+json response",
      message: "{{error}}",
      severity: "error",
      given: OPERATIONS,
      then: { function: problemResponse },
    },
    "slugbase-named-response-schema": {
      description: "Response schemas are named components, never inline objects",
      message: "{{error}}",
      severity: "error",
      resolved: false,
      given: `${OPERATIONS}.responses[*]`,
      then: { function: namedResponseSchemas },
    },
  },
} satisfies RulesetDefinition;
