import type {
  BookmarkModalAiSuggestions,
  FetchAiSuggestionsFn,
  FetchAiSuggestionsParams,
} from "./bookmark-modal-ai.types.js";

const getApiBaseUrl = (): string => process.env["API_BASE_URL"] ?? "";

/** Status codes that indicate the feature is gated or unavailable — return null gracefully. */
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
