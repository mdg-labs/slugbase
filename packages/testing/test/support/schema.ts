import { z } from "zod";

type Json = Record<string, unknown>;

function isJson(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The schema with every `$ref` of the document replaced by what it names. Schemas of the document do not recurse. */
export function inline(document: Json, value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => inline(document, item));
  }
  if (!isJson(value)) {
    return value;
  }
  if (typeof value.$ref === "string") {
    let target: unknown = document;
    for (const segment of value.$ref.slice(2).split("/")) {
      target = isJson(target) ? target[segment] : undefined;
    }
    return inline(document, target);
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, inline(document, item)]));
}

/** A validator for the JSON Schema of a response body, built independently of the generator under test. */
export function validatorFor(document: Json, schema: unknown): z.ZodType {
  return z.fromJSONSchema(inline(document, schema) as Parameters<typeof z.fromJSONSchema>[0]);
}
