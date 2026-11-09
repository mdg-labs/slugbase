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
//
// What the stage decodes it keeps for the stages after it, for the request it hands on: the parsed JSON of a
// route that declares a JSON body (`parsedBody`), and the decoded form of an upload (`decodedForm`), so that a
// large body is decoded once and not again by each stage that needs its content.

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

/** The JSON the stage parsed from a request body, by the request it handed on. */
const parsedBodies = new WeakMap<Request, { readonly value: unknown }>();

/** The bytes the stage read, by the request it handed on. */
const heldBodies = new WeakMap<Request, Uint8Array>();

/** The decoded form of a multipart request, by the request that was decoded. */
const decodedForms = new WeakMap<Request, Promise<FormData>>();

/** The body parsed as JSON, or `undefined` when it is not well-formed (or not UTF-8). */
function parseJson(bytes: Uint8Array): { readonly value: unknown } | undefined {
  try {
    return { value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown };
  } catch {
    return undefined;
  }
}

/** What stage 3 parsed from the body of `request`, when it is the request the stage handed on and its route declares a JSON body. */
export function parsedBody(request: Request): { readonly value: unknown } | undefined {
  return parsedBodies.get(request);
}

/** The bytes of a request body: the ones the stage holds when `request` is the request it handed on, otherwise a copy read from the request, which stays unread. */
export async function bodyBytes(request: Request): Promise<Uint8Array> {
  return heldBodies.get(request) ?? new Uint8Array(await request.clone().arrayBuffer());
}

/**
 * The form of a multipart request, decoded once: every caller for the same request gets the same decoded parts. The decode reads the bytes the stage holds (or a copy of the request) and leaves the body
 * of `request` unread. A body that is no well-formed multipart rejects, for every caller.
 */
export function decodedForm(request: Request): Promise<FormData> {
  let form = decodedForms.get(request);
  if (form === undefined) {
    const held = heldBodies.get(request);
    const source = held === undefined ? request.clone() : new Response(held, { headers: { "content-type": request.headers.get("content-type") ?? "" } });
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- the stage has already read the whole request, at most the route's limit, into memory, so this parses bytes the server holds
    form = source.formData();
    decodedForms.set(request, form);
  }
  return form;
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
  const declaresJson = bytes.byteLength > 0 && operation?.request?.body !== undefined && isJson(contentType);
  const parsed = declaresJson ? parseJson(bytes) : undefined;
  if (declaresJson && parsed === undefined) {
    return refuse(context, "bad_request");
  }

  const handedOn = new Request(raw.url, {
    method: raw.method,
    headers: raw.headers,
    signal: raw.signal,
    ...(bytes.byteLength === 0 ? {} : { body: bytes }),
  });
  if (parsed !== undefined) {
    parsedBodies.set(handedOn, parsed);
  }
  if (bytes.byteLength > 0) {
    heldBodies.set(handedOn, bytes);
  }
  context.req.raw = handedOn;
  return next();
};
