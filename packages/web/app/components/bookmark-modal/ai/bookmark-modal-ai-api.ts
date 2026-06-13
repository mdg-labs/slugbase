import type {
  FetchAiSuggestionsFn,
  FetchAiSuggestionsParams,
  BookmarkModalAiSuggestions,
} from "./bookmark-modal-ai.types.js";
import { apiFetch } from "../../../lib/client-api-fetch.js";

/** Status codes that indicate the feature is gated or unavailable - return null gracefully. */
const SILENT_NULL_STATUSES = new Set([400, 403, 404, 503]);

export const fetchBookmarkModalAiSuggestions: FetchAiSuggestionsFn = async ({
  url,
  outputLanguage,
}: FetchAiSuggestionsParams): Promise<BookmarkModalAiSuggestions | null> => {
  const res = await apiFetch("/ai/suggest", {
    method: "POST",
    csrf: true,
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
