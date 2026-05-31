import type {
  BookmarkModalAiSuggestions,
  FetchAiSuggestionsFn,
  FetchAiSuggestionsParams,
} from "./bookmark-modal-ai.types.js";

const getApiBaseUrl = (): string => process.env["API_BASE_URL"] ?? "";

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

  if (res.status === 404 || res.status === 403 || res.status === 503) {
    return null;
  }

  if (!res.ok) {
    throw new Error("AI suggestion request failed");
  }

  return (await res.json()) as BookmarkModalAiSuggestions;
};
