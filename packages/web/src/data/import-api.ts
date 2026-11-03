import { IMPORT_MAX_BYTES, IMPORT_NETSCAPE_FIELD, type ComponentTypes } from "@slugbase/contracts";
import { ApiProblemError, isSessionEnded, type ApiClient } from "../api/client.ts";

export type ImportResult = ComponentTypes["schemas"]["ImportResult"];

/** The two files the import reads: a SlugBase JSON file (the export) and the bookmark file a browser writes (Netscape HTML). */
export type ImportFormat = "json" | "netscape";

export { IMPORT_MAX_BYTES };

/** What the file picker offers; the extension of a file decides its format. */
export const IMPORT_ACCEPT = ".json,.html,.htm";

const SECONDS_PER_MINUTE = 60;

/** The format a file is read as, from its extension; none for any other file. */
export function importFormatOf(file: File): ImportFormat | undefined {
  const name = file.name.toLowerCase();
  if (name.endsWith(".json")) {
    return "json";
  }
  return name.endsWith(".html") || name.endsWith(".htm") ? "netscape" : undefined;
}

/** Why a file is turned away before any request is sent. */
export type FileRefusal = "unsupported" | "tooLarge";

export function fileRefusalOf(file: File): FileRefusal | undefined {
  if (importFormatOf(file) === undefined) {
    return "unsupported";
  }
  return file.size > IMPORT_MAX_BYTES ? "tooLarge" : undefined;
}

export interface ImportRequest {
  readonly file: File;
  readonly format: ImportFormat;
  readonly skipDuplicates: boolean;
  /** true asks what the import would do and writes nothing. */
  readonly dryRun: boolean;
  /** Makes a repeat of the same request safe: the server answers the stored result instead of importing again. */
  readonly idempotencyKey?: string;
}

/** The file could not be read from the disk, for example because it was moved or removed after it was chosen. */
export class FileReadError extends Error {
  constructor(options: { cause: unknown }) {
    super("The chosen file could not be read", options);
    this.name = "FileReadError";
  }
}

async function readText(file: File): Promise<string> {
  try {
    return await file.text();
  } catch (caught) {
    throw new FileReadError({ cause: caught });
  }
}

/**
 * Sends the file to the import of its format. A SlugBase JSON file goes as the text it holds, so the server reads
 * what the file says and not a copy that this page parsed; a browser bookmark file goes as the one file part of a
 * multipart request, whose content type the browser sets with its boundary.
 */
export async function sendImport(api: ApiClient, request: ImportRequest, signal: AbortSignal): Promise<ImportResult> {
  const params = {
    query: { dryRun: request.dryRun ? "true" : "false", skipDuplicates: request.skipDuplicates ? "true" : "false" },
    header: request.idempotencyKey === undefined ? {} : { "Idempotency-Key": request.idempotencyKey },
  } as const;
  if (request.format === "json") {
    const text = await readText(request.file);
    const { data, error } = await api.POST("/api/v1/import/json", { params, body: [], bodySerializer: () => text, signal });
    if (data === undefined) {
      throw new Error("The import did not answer with a document", { cause: error });
    }
    return data;
  }
  const { data, error } = await api.POST("/api/v1/import/netscape", {
    params,
    body: { file: "" },
    bodySerializer: () => {
      const form = new FormData();
      form.append(IMPORT_NETSCAPE_FIELD, request.file, request.file.name);
      return form;
    },
    signal,
  });
  if (data === undefined) {
    throw new Error("The import did not answer with a document", { cause: error });
  }
  return data;
}

/** Why a request did not go through, as far as the member is told. */
export type ImportFailure =
  | { readonly kind: "payloadTooLarge" }
  | { readonly kind: "unsupportedType" }
  | { readonly kind: "newerVersion" }
  | { readonly kind: "tooManyNewNames" }
  | { readonly kind: "tooManyBookmarks" }
  | { readonly kind: "tooManyAssignments" }
  | { readonly kind: "invalid" }
  | { readonly kind: "rateLimited"; readonly seconds: number | undefined }
  | { readonly kind: "unreadable" }
  | { readonly kind: "network" }
  | { readonly kind: "failed" };

function refused(error: ApiProblemError, path: string, code: string): boolean {
  return error.errors.some((entry) => entry.path === path && entry.code === code);
}

/** The failure to show for an error; undefined for an ended session, which the app answers as a whole. */
export function importFailureOf(error: unknown): ImportFailure | undefined {
  if (isSessionEnded(error)) {
    return undefined;
  }
  if (error instanceof FileReadError) {
    return { kind: "unreadable" };
  }
  if (!(error instanceof ApiProblemError)) {
    return { kind: "network" };
  }
  switch (error.status) {
    case 413:
      return { kind: "payloadTooLarge" };
    case 415:
      return { kind: "unsupportedType" };
    case 429:
      return { kind: "rateLimited", seconds: error.retryAfterSeconds };
    case 400:
      return { kind: "invalid" };
    case 422:
      if (error.errors.some((entry) => entry.path === "version")) {
        return { kind: "newerVersion" };
      }
      if (refused(error, "", "too_many_new_names")) {
        return { kind: "tooManyNewNames" };
      }
      // `too_big` at the root is a browser file, or a plain array, of more bookmarks than one import reads.
      if (refused(error, "", "too_big") || refused(error, "bookmarks", "too_big")) {
        return { kind: "tooManyBookmarks" };
      }
      // `too_many_links` is a file whose bookmarks name more folders and tags in total than one import takes, whatever the number of bookmarks.
      if (refused(error, "", "too_many_links")) {
        return { kind: "tooManyAssignments" };
      }
      return { kind: "invalid" };
    default:
      return { kind: "failed" };
  }
}

/** The wait of a rate limit as whole minutes or seconds, for the message that names it. */
export function waitOf(seconds: number): { readonly unit: "seconds" | "minutes"; readonly count: number } {
  return seconds < SECONDS_PER_MINUTE ? { unit: "seconds", count: seconds } : { unit: "minutes", count: Math.ceil(seconds / SECONDS_PER_MINUTE) };
}
