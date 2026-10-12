import type { ChainContext, RequestStage } from "./chain.ts";
import { problemDocument, requestIdOf } from "./problem.ts";

// Stage 3 of the chain (doc 01 section 4): the request body is read here, counted
// on the bytes that arrive, and refused as soon as it passes the route's limit.
// What was read is handed on as the request's body, so a later stage reads it
// again from memory. A body is never held beyond the limit: the read is cut off
// at the first chunk that passes it, and a declared Content-Length over the limit
// is refused before any byte is read.
//
// Malformed JSON is answered here, but only for a route that declares a JSON
// request body and a request that says it is JSON and sends a body: a missing
// body is for the validation stage, and the content-type rule for a
// browser-facing request belongs to stage 5. A bearer-authenticated mutation has
// no ambient credential for stage 5 to check, so its content type is checked
// here, ahead of authentication, by the credential the request presents.

/** 64 KiB: the limit of a route whose operation declares none. */
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

const MUTATIONS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const BEARER = /^bearer\s/i;

const DETAILS = {
  payload_too_large: "The request body is larger than this route accepts.",
  bad_request: "The request body is not valid JSON.",
  unsupported_media_type: "This request must be sent as application/json.",
} as const;

function refuse(context: ChainContext, code: keyof typeof DETAILS): Response {
  const response = problemDocument(requestIdOf(context), { code, detail: DETAILS[code] });
  // The rest of an oversized body is never read: the connection is not reused.
  if (code === "payload_too_large") {
    response.headers.set("connection", "close");
  }
  return response;
}

function isJson(contentType: string | null): boolean {
  return contentType?.split(";")[0]?.trim().toLowerCase() === "application/json";
}

function declaredLength(headers: Headers): number | undefined {
  const value = headers.get("content-length");
  if (value === null || headers.has("transfer-encoding") || !/^\d+$/.test(value)) {
    return undefined;
  }
  return Number(value);
}

/** The body's bytes, or `undefined` once more than `limit` of them have arrived. */
async function readUpTo(body: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array | undefined> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > limit) {
      void reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function isWellFormedJson(bytes: Uint8Array): boolean {
  try {
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return true;
  } catch {
    return false;
  }
}

/** Stage 3: per-route body limit, malformed-JSON answer and the content type of a bearer mutation. */
export const bodyLimits: RequestStage = async (context, next) => {
  const raw = context.req.raw;
  if (raw.body === null) {
    return next();
  }

  const operation = context.get("route")?.operation;
  const limit = operation?.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const declared = declaredLength(raw.headers);
  if (declared !== undefined && declared > limit) {
    return refuse(context, "payload_too_large");
  }
  const bytes = await readUpTo(raw.body, limit);
  if (bytes === undefined) {
    return refuse(context, "payload_too_large");
  }

  const contentType = raw.headers.get("content-type");
  if (bytes.byteLength > 0) {
    const bearer = BEARER.test(raw.headers.get("authorization") ?? "");
    if (bearer && MUTATIONS.has(raw.method.toUpperCase()) && !isJson(contentType)) {
      return refuse(context, "unsupported_media_type");
    }
  }
  if (bytes.byteLength > 0 && operation?.request?.body !== undefined && isJson(contentType) && !isWellFormedJson(bytes)) {
    return refuse(context, "bad_request");
  }

  context.req.raw = new Request(raw.url, {
    method: raw.method,
    headers: raw.headers,
    signal: raw.signal,
    ...(bytes.byteLength === 0 ? {} : { body: bytes }),
  });
  return next();
};
