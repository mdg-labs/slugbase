import type { z } from "zod";
import { refuseUncallableToken } from "./authorize.ts";
import type { ChainContext, MatchedRoute, RequestStage, ValidatedInput } from "./chain.ts";
import { ProblemError, VALIDATION_FAILED_DETAIL, fieldErrors, type ProblemFieldError } from "./problem.ts";

// Stage 8 of the chain (doc 01 section 4): the request is parsed with the Zod
// schemas its operation declares, and what the handler receives is what they
// returned. Unknown fields are refused (doc 04 section 2.3): the body schemas of
// the contract are strict objects, and the path and query schemas are made
// strict here. A failure names the fields and the codes of the issues, never
// the values the caller sent.

const JSON_MEDIA_TYPE = "application/json";

const DETAILS = {
  bad_request: "The request body is not valid JSON.",
  unsupported_media_type: "This request must be sent as application/json.",
} as const;

const strictSchemas = new WeakMap<z.ZodObject, z.ZodObject>();

function strict(schema: z.ZodObject): z.ZodObject {
  let closed = strictSchemas.get(schema);
  if (closed === undefined) {
    closed = schema.strict();
    strictSchemas.set(schema, closed);
  }
  return closed;
}

function queryOf(url: string): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  for (const [name, value] of new URL(url).searchParams) {
    const seen = Object.hasOwn(query, name) ? query[name] : undefined;
    if (seen === undefined) {
      Object.defineProperty(query, name, { value, enumerable: true, writable: true, configurable: true });
    } else if (typeof seen === "string") {
      query[name] = [seen, value];
    } else {
      seen.push(value);
    }
  }
  return query;
}

async function bodyOf(context: ChainContext): Promise<unknown> {
  const raw = context.req.raw;
  const text = await raw.clone().text();
  if (text === "") {
    return undefined;
  }
  if (raw.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== JSON_MEDIA_TYPE) {
    throw new ProblemError("unsupported_media_type", DETAILS.unsupported_media_type);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProblemError("bad_request", DETAILS.bad_request);
  }
}

async function validate(context: ChainContext, route: MatchedRoute): Promise<ValidatedInput> {
  const request = route.operation.request;
  const errors: ProblemFieldError[] = [];
  const input: { params?: unknown; query?: unknown; body?: unknown } = {};

  const check = (part: "params" | "query" | "body", schema: z.ZodType, value: unknown): void => {
    const result = schema.safeParse(value);
    if (result.success) {
      input[part] = result.data;
    } else {
      errors.push(...fieldErrors(result.error));
    }
  };

  if (request?.params !== undefined) {
    check("params", strict(request.params), route.params);
  }
  if (request?.query !== undefined) {
    check("query", strict(request.query), queryOf(context.req.url));
  }
  // A multipart route (the import upload) reads its own body.
  if (request?.body !== undefined && route.acceptsMultipart !== true) {
    check("body", request.body, await bodyOf(context));
  }

  if (errors.length > 0) {
    throw new ProblemError("validation_failed", VALIDATION_FAILED_DETAIL, { errors });
  }
  return input;
}

/** Stage 8: refuses a token on an account or member operation without a token scope (`anonymous` and `machine` operations are not subject to this check and their handlers do not read the token), then parses the matched operation's params, query and body; a request that matches no operation passes through to the 404. */
export const validation: RequestStage = async (context, next) => {
  const route = context.get("route");
  if (route !== undefined) {
    // An operation a token may never call is refused before its body is read (doc 04 section 4.2).
    refuseUncallableToken(context.get("principal"), route.operation);
    context.set("input", await validate(context, route));
  }
  return next();
};
