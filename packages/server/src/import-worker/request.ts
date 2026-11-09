import { IDEMPOTENCY_KEY_HEADER, type OperationDefinition } from "@slugbase/contracts";
import { readPreparedImport, type PreparedImport } from "@slugbase/core";
import { takeHeldBody } from "../http/body-limits.ts";
import { MAX_FIELD_ERRORS, ProblemError, type ProblemFieldError } from "../http/problem.ts";
import { importWorker, ImportWorkerBusy, ImportWorkerError } from "./client.ts";
import type { ImportJobKind } from "./job.ts";

// The import of a request, read on the worker thread (doc 02 section 13.1, doc 01 section 8.1). The body-limits stage holds the bytes of the request; for the two import operations nothing on the request thread decodes or parses
// them: the first stage that needs the body (the validation stage for a JSON file, the idempotency stage or the handler for an upload) hands them to the worker once for the request, and every later reader gets the same answer, so a
// file is read once however many stages ask. The answer is data from another thread and is checked here (`readOutcome`) before anything uses it: the prepared import against the bounds of the contract (`readPreparedImport`), the
// field errors against the most a problem document carries, and the digests against the types the request hash reads.

const BUSY = "Other imports are waiting to be read; try again shortly.";

/** What the worker made of a request body, checked. */
export type ImportRead =
  | { readonly kind: "prepared"; readonly prepared: PreparedImport; readonly canonicalBody?: Uint8Array; readonly uploadDigest?: string }
  | { readonly kind: "malformed" | "too_large"; readonly uploadDigest?: string }
  | { readonly kind: "invalid"; readonly errors: readonly ProblemFieldError[]; readonly uploadDigest?: string };

const reads = new WeakMap<Request, { readonly kind: ImportJobKind; readonly read: Promise<ImportRead> }>();

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bad(what: string): never {
  throw new ImportWorkerError(`the import worker answered with ${what}`);
}

function fieldErrorsOf(value: unknown): ProblemFieldError[] {
  if (!Array.isArray(value) || value.length > MAX_FIELD_ERRORS) {
    return bad("field errors that are not a short list");
  }
  return (value as unknown[]).map((entry) => {
    if (!isRecord(entry) || typeof entry["path"] !== "string" || typeof entry["code"] !== "string" || entry["path"].length > 4096 || entry["code"].length > 64) {
      return bad("a field error that is not a path and a code");
    }
    return { path: entry["path"], code: entry["code"] };
  });
}

/** `outcome` as the worker's answer to a job of `kind`, or an `ImportWorkerError` when it is none. `digest` says whether the job asked for what the request hash needs. */
export function readOutcome(outcome: unknown, kind: ImportJobKind, digest: boolean): ImportRead {
  if (!isRecord(outcome)) {
    return bad("something that is no outcome");
  }
  const uploadDigest = outcome["uploadDigest"];
  if (uploadDigest !== undefined && (kind !== "netscape" || typeof uploadDigest !== "string" || uploadDigest.length > 128)) {
    return bad("a digest it was not asked for");
  }
  if (kind === "netscape" && digest && uploadDigest === undefined) {
    return bad("no digest of the upload");
  }
  const withDigest = uploadDigest === undefined ? {} : { uploadDigest };
  switch (outcome["kind"]) {
    case "prepared": {
      const prepared = readPreparedImport(outcome["prepared"]);
      const canonicalBody = outcome["canonicalBody"];
      if (prepared === undefined) {
        return bad("a file that is not a prepared import");
      }
      if (canonicalBody !== undefined && (kind !== "json" || !(canonicalBody instanceof Uint8Array))) {
        return bad("a body it was not asked for");
      }
      if (kind === "json" && digest && canonicalBody === undefined) {
        return bad("no canonical body");
      }
      return { kind: "prepared", prepared, ...withDigest, ...(canonicalBody === undefined ? {} : { canonicalBody }) };
    }
    case "malformed":
      return { kind: "malformed", ...withDigest };
    case "too_large":
      return kind === "netscape" ? { kind: "too_large", ...withDigest } : bad("a file that is too large for a JSON body");
    case "invalid":
      return { kind: "invalid", errors: fieldErrorsOf(outcome["errors"]), ...withDigest };
    default:
      return bad("an outcome of a kind it does not have");
  }
}

/** Whether the request carries the `Idempotency-Key` of an operation that stores answers under one: only then does the request hash read the body, so only then does the worker digest it. */
export function wantsDigest(request: Request, operation: OperationDefinition): boolean {
  return operation.idempotency === true && request.headers.has(IDEMPOTENCY_KEY_HEADER);
}

/**
 * What the worker made of the body of `request`: the first call hands the body to the worker, and every call for the same request after it answers the same promise. `digest` is read by the first call only; a later call
 * that needs the digest must come after one that asked for it.
 */
export function importRead(request: Request, kind: ImportJobKind, digest: boolean): Promise<ImportRead> {
  const started = reads.get(request);
  if (started !== undefined) {
    if (started.kind !== kind) {
      throw new Error("the body of a request is read as one kind of import");
    }
    return started.read;
  }
  const read = (async () => {
    const bytes = await takeHeldBody(request);
    try {
      return readOutcome(await importWorker().run({ kind, bytes, contentType: request.headers.get("content-type") ?? "", digest }), kind, digest);
    } catch (error) {
      throw error instanceof ImportWorkerBusy ? new ProblemError("unavailable", BUSY) : error;
    }
  })();
  // The caller awaits the answer; this keeps a failure that no later stage asks about from being an unhandled rejection.
  read.catch(() => undefined);
  reads.set(request, { kind, read });
  return read;
}

/** The read of a body that a stage before has asked the worker for already. */
export function startedImportRead(request: Request, kind: ImportJobKind): Promise<ImportRead> {
  const started = reads.get(request);
  if (started?.kind !== kind) {
    throw new Error("the body of this request was not read by the import worker");
  }
  return started.read;
}
