import type { paths } from "@slugbase/contracts";
import { ApiProblemError, isSessionEnded, type ApiClient } from "../api/client.ts";
import type { BookmarkFilterParams } from "../bookmarks/list-search.ts";

/** The two files the export writes: a SlugBase JSON document (lossless) and a Netscape bookmark file for browsers (lossy). */
export type ExportFormat = "json" | "netscape";

/** The most bookmarks an export names by identifier (doc 04 section 10.9); more are exported by the filters that match them. */
export const EXPORT_SELECTION_IDS_MAX = 100;

/** Which bookmarks an export holds when it is not the whole library: the ones named, or every one the filters of the list match. */
export type ExportSelection =
  | { readonly kind: "ids"; readonly ids: readonly string[] }
  | { readonly kind: "filter"; readonly filters: BookmarkFilterParams };

export interface ExportRequest {
  readonly format: ExportFormat;
  /** Adds the bookmarks shared with the member, as their readable fields only. A selection holds the shared bookmarks it names or matches, so this is not sent with one. */
  readonly includeShared: boolean;
  /** The bookmarks to export; the member's whole library when left out. */
  readonly selection?: ExportSelection | undefined;
}

/** The bytes of an export and the name to save them under. */
export interface ExportFile {
  readonly blob: Blob;
  readonly fileName: string;
  /** How many bookmarks the file holds, as the server counted them when the file began; undefined when it did not say. */
  readonly count: number | undefined;
}

const EXTENSION: Record<ExportFormat, string> = { json: ".json", netscape: ".html" };

/** Letters, digits, dot, dash and underscore, starting with a letter or digit: no path, no space, nothing a file system treats specially. */
const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * The file name an export is saved under: the one the response's `Content-Disposition` names. A response is data, so the name is used only
 * when it is a plain file name with the extension of the format that was asked for; any other (a path, a different extension, no name at all)
 * is replaced by a fixed one.
 */
export function exportFileNameOf(header: string | null, format: ExportFormat): string {
  const fallback = `slugbase-export${EXTENSION[format]}`;
  if (header === null) {
    return fallback;
  }
  const named = /;\s*filename="([^"\\]*)"/i.exec(header) ?? /;\s*filename=([^";\s]+)/i.exec(header);
  const name = named?.[1];
  return name !== undefined && SAFE_FILE_NAME.test(name) && name.toLowerCase().endsWith(EXTENSION[format]) ? name : fallback;
}

/** The count the server sent in `X-Export-Count`, if it is a whole number. */
export function exportCountOf(header: string | null): number | undefined {
  return header !== null && /^\d{1,9}$/.test(header) ? Number(header) : undefined;
}

/**
 * The query of a request. A selection by filters always names its scope, which is "all" when the list's address leaves it out, as the list's is: the server takes a request with no selection parameter for the
 * whole export of the member's own bookmarks, and the filters of an unfiltered list would otherwise name nothing.
 */
function queryOf(request: ExportRequest): NonNullable<paths["/api/v1/export/json"]["get"]["parameters"]["query"]> {
  const { selection } = request;
  if (selection === undefined) {
    return { includeShared: request.includeShared ? "true" : "false" };
  }
  return selection.kind === "ids" ? { id: [...selection.ids] } : { ...selection.filters, scope: selection.filters.scope ?? "all" };
}

/**
 * Fetches the export as a blob through the API client, so a refusal is a problem document and not the browser's own failed download.
 * The server streams the file and stores nothing; the browser holds it in memory until it is saved.
 */
export async function fetchExport(api: ApiClient, request: ExportRequest, signal?: AbortSignal): Promise<ExportFile> {
  const init = { params: { query: queryOf(request) }, parseAs: "blob", ...(signal === undefined ? {} : { signal }) } as const;
  const { data, error, response } =
    request.format === "json" ? await api.GET("/api/v1/export/json", init) : await api.GET("/api/v1/export/netscape", init);
  if (data === undefined) {
    throw new Error("The export did not answer with a file", { cause: error });
  }
  return { blob: data, fileName: exportFileNameOf(response.headers.get("Content-Disposition"), request.format), count: exportCountOf(response.headers.get("X-Export-Count")) };
}

const REVOKE_DELAY_MS = 1000;

/**
 * Saves a file through the browser: an object URL on a temporary anchor that is clicked. The URL is revoked a moment later, once the
 * browser has taken the file, and at once if the click throws.
 */
export function saveFile(file: ExportFile): void {
  const url = URL.createObjectURL(file.blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = file.fileName;
    anchor.rel = "noopener";
    anchor.hidden = true;
    document.body.append(anchor);
    try {
      anchor.click();
    } finally {
      anchor.remove();
    }
  } catch (caught) {
    URL.revokeObjectURL(url);
    throw caught;
  }
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, REVOKE_DELAY_MS);
}

/** Why an export did not reach the disk, as far as the member is told. */
export type ExportFailure =
  | { readonly kind: "signedOut" }
  | { readonly kind: "rateLimited"; readonly seconds: number | undefined }
  | { readonly kind: "unavailable" }
  | { readonly kind: "tooMany" }
  | { readonly kind: "network" }
  | { readonly kind: "failed" };

export function exportFailureOf(error: unknown): ExportFailure {
  if (isSessionEnded(error)) {
    return { kind: "signedOut" };
  }
  if (!(error instanceof ApiProblemError)) {
    return error instanceof TypeError || error instanceof DOMException ? { kind: "network" } : { kind: "failed" };
  }
  switch (error.status) {
    case 429:
      return { kind: "rateLimited", seconds: error.retryAfterSeconds };
    case 503:
      return { kind: "unavailable" };
    case 422:
      return { kind: "tooMany" };
    default:
      return { kind: "failed" };
  }
}
