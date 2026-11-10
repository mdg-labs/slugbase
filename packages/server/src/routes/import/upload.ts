import type { PreparedImport } from "@slugbase/core";
import type { ChainContext } from "../../http/chain.ts";
import { ProblemError, VALIDATION_FAILED_DETAIL } from "../../http/problem.ts";
import { importRead } from "../../import-worker/request.ts";

// The upload of POST /api/v1/import/netscape (doc 04 sections 5.1 and 10.9, doc 10 T5 and T13). The route is registered with `acceptsMultipart`, so the cross-site stage lets `multipart/form-data` through
// and the validation stage leaves the body alone; this reads it. The body-limits stage has already counted the request and holds its bytes, and the import worker thread reads them (`import-worker/job.ts`): it decodes the form,
// reads the file as UTF-8 text with the parser of `@slugbase/core`, which builds no document and runs and follows nothing, and reads each bookmark, so that none of that holds the thread that serves the other requests. It reads
// them once for the request: the idempotency stage's digest of the parts and this share the one read. The request must be `multipart/form-data` (a JSON request, which the cross-site stage also admits on a route that accepts
// multipart, is `415`), and it holds one part, the file. A body that is not well-formed multipart is `400`; a missing or repeated file part, a part that is text, or another part is `422`; a file over 5 MiB is `413` (the request
// limit is larger than that by the envelope), and one with more than 5 000 links is `422`.

const MULTIPART = "multipart/form-data";

const REFUSALS = {
  not_multipart: "This request must be sent as multipart/form-data.",
  malformed: "The request body is not well-formed multipart/form-data.",
  file_too_large: "The file is larger than 5 MiB.",
} as const;

function mediaTypeOf(context: ChainContext): string | undefined {
  return context.req.header("content-type")?.split(";")[0]?.trim().toLowerCase();
}

/** The upload as the worker read it, prepared for the import, or the problem that says why the upload is no file of bookmarks. */
export async function uploadedImport(context: ChainContext): Promise<PreparedImport> {
  if (mediaTypeOf(context) !== MULTIPART) {
    throw new ProblemError("unsupported_media_type", REFUSALS.not_multipart);
  }
  const read = await importRead(context.req.raw, "netscape", false);
  switch (read.kind) {
    case "malformed":
      throw new ProblemError("bad_request", REFUSALS.malformed);
    case "too_large":
      throw new ProblemError("payload_too_large", REFUSALS.file_too_large);
    case "invalid":
      throw new ProblemError("validation_failed", VALIDATION_FAILED_DETAIL, { errors: read.errors });
    case "prepared":
      return read.prepared;
  }
}
