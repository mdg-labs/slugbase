import { createHash } from "node:crypto";
import { IMPORT_NETSCAPE_FIELD, IMPORT_NETSCAPE_MAX_FILE_BYTES, ImportRequestSchema } from "@slugbase/contracts";
import { parseNetscapeBookmarks, prepareImport, type PreparedImport } from "@slugbase/core";
import { fieldErrors } from "../http/problem.ts";
import { canonical } from "./canonical.ts";

// The CPU work of an import (doc 02 section 13.1, doc 01 section 8.1, doc 10 T13), as one function of the bytes of the request: the decode of an upload or the parse of a JSON body, the contract's schema, the reader of a
// browser's bookmark file, and the reading of each bookmark (`prepareImport`). It runs in the import worker thread (`worker.ts`), so that none of it holds the thread that serves the other requests, and it touches no database:
// what it answers is plain data, and the thread that writes decides every cap and the whole transaction. The body limit has been enforced by the body-limits stage before the bytes reach it.

export type ImportJobKind = "json" | "netscape";

export interface ImportJob {
  readonly kind: ImportJobKind;
  /** The bytes of the request body, as the body-limits stage read them. */
  readonly bytes: Uint8Array;
  /** The `Content-Type` of the request, which carries the boundary of an upload. */
  readonly contentType: string;
  /** True when the request carries an `Idempotency-Key`: the answer then holds what the request hash needs of the body (`canonicalBody`, `uploadDigest`). */
  readonly digest: boolean;
}

/** Where a request body is wrong and why, the way the validation stage reports it: the path of a field and the code of the issue, never the value. */
export interface ImportFieldIssue {
  readonly path: string;
  readonly code: string;
}

export type ImportJobOutcome =
  /** The file, read. `canonicalBody` is the JSON of the validated body with its members in a fixed order, and `uploadDigest` the digest of the parts of an upload: whichever the request hash of the kind needs, when `digest` was asked. */
  | { readonly kind: "prepared"; readonly prepared: PreparedImport; readonly canonicalBody?: Uint8Array; readonly uploadDigest?: string }
  /** A JSON body that is not JSON, or an upload that is not well-formed multipart. */
  | { readonly kind: "malformed"; readonly uploadDigest?: string }
  /** The file part of an upload is over the largest file. */
  | { readonly kind: "too_large"; readonly uploadDigest?: string }
  /** The body is not the format: a JSON file that fails the contract's schema, or an upload that is not exactly one file. */
  | { readonly kind: "invalid"; readonly errors: readonly ImportFieldIssue[]; readonly uploadDigest?: string };

function invalid(code: string, path: string, uploadDigest: string | undefined): ImportJobOutcome {
  return { kind: "invalid", errors: [{ path, code }], ...(uploadDigest === undefined ? {} : { uploadDigest }) };
}

/** The digest of the parts of a form, in order: each part's name, whether it is text or a file, and its content, each length-prefixed so that no two requests share a digest by where one part ends. */
async function partsDigest(form: FormData): Promise<string> {
  const digest = createHash("sha256");
  const add = (bytes: Uint8Array): void => {
    digest.update(`${String(bytes.byteLength)}:`);
    digest.update(bytes);
  };
  for (const [name, value] of form) {
    add(new TextEncoder().encode(name));
    if (typeof value === "string") {
      digest.update("s");
      add(new TextEncoder().encode(value));
    } else {
      digest.update("f");
      add(new Uint8Array(await value.arrayBuffer()));
    }
  }
  return `parts:${digest.digest("hex")}`;
}

function bytesDigest(bytes: Uint8Array): string {
  return `bytes:${createHash("sha256").update(bytes).digest("hex")}`;
}

function jsonJob(job: ImportJob): ImportJobOutcome {
  let body: unknown;
  if (job.bytes.byteLength > 0) {
    try {
      body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(job.bytes)) as unknown;
    } catch {
      return { kind: "malformed" };
    }
  }
  const checked = ImportRequestSchema.safeParse(body);
  if (!checked.success) {
    return { kind: "invalid", errors: fieldErrors(checked.error) };
  }
  const prepared = prepareImport(checked.data);
  return { kind: "prepared", prepared, ...(job.digest ? { canonicalBody: new TextEncoder().encode(JSON.stringify(canonical(checked.data))) } : {}) };
}

async function netscapeJob(job: ImportJob): Promise<ImportJobOutcome> {
  let form: FormData;
  try {
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- the body-limits stage has already read the whole request, at most the route's limit, so this decodes bytes the worker holds
    form = await new Response(job.bytes, { headers: { "content-type": job.contentType } }).formData();
  } catch {
    return { kind: "malformed", ...(job.digest ? { uploadDigest: bytesDigest(job.bytes) } : {}) };
  }
  let uploadDigest: string | undefined;
  try {
    uploadDigest = job.digest ? await partsDigest(form) : undefined;
  } catch {
    uploadDigest = bytesDigest(job.bytes);
  }

  let file: File | undefined;
  for (const [name, value] of form) {
    if (name !== IMPORT_NETSCAPE_FIELD) {
      return invalid("unrecognized_keys", "", uploadDigest);
    }
    if (typeof value === "string") {
      return invalid("invalid_type", IMPORT_NETSCAPE_FIELD, uploadDigest);
    }
    if (file !== undefined) {
      return invalid("too_big", IMPORT_NETSCAPE_FIELD, uploadDigest);
    }
    file = value;
  }
  if (file === undefined) {
    return invalid("invalid_type", IMPORT_NETSCAPE_FIELD, uploadDigest);
  }
  if (file.size > IMPORT_NETSCAPE_MAX_FILE_BYTES) {
    return { kind: "too_large", ...(uploadDigest === undefined ? {} : { uploadDigest }) };
  }
  const read = parseNetscapeBookmarks(new Uint8Array(await file.arrayBuffer()));
  if (read.kind === "too_many") {
    return invalid("too_big", "", uploadDigest);
  }
  return { kind: "prepared", prepared: prepareImport([...read.bookmarks]), ...(uploadDigest === undefined ? {} : { uploadDigest }) };
}

/** Does the work of an import job. It reads nothing but the bytes it is given and writes nothing. */
export async function runImportJob(job: ImportJob): Promise<ImportJobOutcome> {
  return job.kind === "json" ? jsonJob(job) : await netscapeJob(job);
}
