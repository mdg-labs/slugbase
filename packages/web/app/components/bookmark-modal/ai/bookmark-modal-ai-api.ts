import type {
  BookmarkModalAiSuggestions,
  FetchAiSuggestionsFn,
  FetchAiSuggestionsParams,
} from "./bookmark-modal-ai.types.js";

const getApiBaseUrl = (): string => {
  const fromProcess = typeof process !== "undefined" ? process.env["API_BASE_URL"] : undefined;
  if (typeof fromProcess === "string" && fromProcess.length > 0) return fromProcess.replace(/\/$/, "");
  const fromVite = typeof import.meta !== "undefined" ? (import.meta as { env: { VITE_API_URL?: string } }).env.VITE_API_URL : undefined;
  if (typeof fromVite === "string" && fromVite.length > 0) return fromVite.replace(/\/$/, "");
  return "";
};

/** Status codes that indicate the feature is gated or unavailable - return null gracefully. */
const SILENT_NULL_STATUSES = new Set([400, 403, 404, 503]);

export const fetchBookmarkModalAiSuggestions: FetchAiSuggestionsFn = async ({
  url,
  outputLanguage,
}: FetchAiSuggestionsParams): Promise<BookmarkModalAiSuggestions | null> => {
  const res = await fetch(`${getApiBaseUrl()}/ai/suggest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ url, outputLanguage }),
  });

  if (SILENT_NULL_STATUSES.has(res.status)) {
    return null;
  }

  if (!res.ok) {
    throw new Error("AI suggestion request failed");
  }

  return (await res.json()) as BookmarkModalAiSuggestions;
};
