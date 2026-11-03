import { IMPORT_MAX_BOOKMARKS, IMPORT_NETSCAPE_FIELD, IMPORT_NETSCAPE_MAX_FILE_BYTES, type ImportFileBookmark } from "@slugbase/contracts";
import { parseNetscapeBookmarks } from "@slugbase/core";
import type { ChainContext } from "../../http/chain.ts";
import { ProblemError, VALIDATION_FAILED_DETAIL } from "../../http/problem.ts";

// The upload of POST /api/v1/import/netscape (doc 04 sections 5.1 and 10.9, doc 10 T5 and T13). The route is registered with `acceptsMultipart`, so the cross-site stage lets `multipart/form-data` through
// and the validation stage leaves the body alone; this reads it. The body-limits stage has already counted the request and holds it in memory, so the parse reads bytes it has, never the socket. The
// request must be `multipart/form-data` (a JSON request, which the cross-site stage also admits on a route that accepts multipart, is `415`), and it holds one part, the file. A body that is not
// well-formed multipart is `400`; a missing or repeated file part, a part that is text, or another part is `422`; a file over 5 MiB is `413` (the request limit is larger than that by the envelope).
// The file is read as UTF-8 text by the parser of `@slugbase/core`, which builds no document and runs and follows nothing.

const MULTIPART = "multipart/form-data";

const REFUSALS = {
  not_multipart: "This request must be sent as multipart/form-data.",
  malformed: "The request body is not well-formed multipart/form-data.",
  file_too_large: "The file is larger than 5 MiB.",
  too_many_links: `The file has more than ${String(IMPORT_MAX_BOOKMARKS)} links; one import reads at most that many.`,
} as const;

function mediaTypeOf(context: ChainContext): string | undefined {
  return context.req.header("content-type")?.split(";")[0]?.trim().toLowerCase();
}

function invalid(code: string, path: string): ProblemError {
  return new ProblemError("validation_failed", VALIDATION_FAILED_DETAIL, { errors: [{ path, code }] });
}

/** The bookmarks the uploaded file lists, or the problem that says why the upload is no file of bookmarks. */
export async function uploadedBookmarks(context: ChainContext): Promise<ImportFileBookmark[]> {
  if (mediaTypeOf(context) !== MULTIPART) {
    throw new ProblemError("unsupported_media_type", REFUSALS.not_multipart);
  }
  let form: FormData;
  try {
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- the body-limits stage has already read the whole request, at most the route's limit, into memory, so this parses bytes the server holds
    form = await context.req.raw.formData();
  } catch {
    throw new ProblemError("bad_request", REFUSALS.malformed);
  }

  let file: File | undefined;
  for (const [name, value] of form) {
    if (name !== IMPORT_NETSCAPE_FIELD) {
      throw invalid("unrecognized_keys", "");
    }
    if (typeof value === "string") {
      throw invalid("invalid_type", IMPORT_NETSCAPE_FIELD);
    }
    if (file !== undefined) {
      throw invalid("too_big", IMPORT_NETSCAPE_FIELD);
    }
    file = value;
  }
  if (file === undefined) {
    throw invalid("invalid_type", IMPORT_NETSCAPE_FIELD);
  }
  if (file.size > IMPORT_NETSCAPE_MAX_FILE_BYTES) {
    throw new ProblemError("payload_too_large", REFUSALS.file_too_large);
  }

  const read = parseNetscapeBookmarks(new Uint8Array(await file.arrayBuffer()));
  if (read.kind === "too_many") {
    throw invalid("too_big", "");
  }
  return [...read.bookmarks];
}
