import { useEffect, useRef, useState } from "react";

import { fetchBookmarkModalAiSuggestions } from "./bookmark-modal-ai-api.js";
import { canRequestBookmarkModalAiSuggestions } from "./bookmark-modal-ai-gates.js";
import type {
  BookmarkModalAiContext,
  BookmarkModalAiSuggestionsState,
  FetchAiSuggestionsFn,
} from "./bookmark-modal-ai.types.js";
import { useDebouncedValue } from "./use-debounced-value.js";

const AI_URL_DEBOUNCE_MS = 450;

function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export type UseBookmarkModalAiSuggestionsOptions = {
  open: boolean;
  url: string;
  aiContext: BookmarkModalAiContext;
  fetchSuggestions?: FetchAiSuggestionsFn;
};

export function useBookmarkModalAiSuggestions({
  open,
  url,
  aiContext,
  fetchSuggestions = fetchBookmarkModalAiSuggestions,
}: UseBookmarkModalAiSuggestionsOptions): BookmarkModalAiSuggestionsState & {
  enabled: boolean;
} {
  const debouncedUrl = useDebouncedValue(url.trim(), AI_URL_DEBOUNCE_MS);
  const [state, setState] = useState<BookmarkModalAiSuggestionsState>({
    status: "idle",
    suggestions: null,
  });
  const requestIdRef = useRef(0);

  const enabled = canRequestBookmarkModalAiSuggestions(aiContext);

  useEffect(() => {
    if (!open || !enabled) {
      requestIdRef.current += 1;
      setState({ status: "idle", suggestions: null });
      return;
    }

    if (!debouncedUrl || !isValidHttpUrl(debouncedUrl)) {
      requestIdRef.current += 1;
      setState({ status: "idle", suggestions: null });
      return;
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setState({ status: "loading", suggestions: null });

    void (async () => {
      try {
        const suggestions = await fetchSuggestions({
          url: debouncedUrl,
          outputLanguage: aiContext.outputLanguage,
        });
        if (requestIdRef.current !== requestId) return;
        if (!suggestions) {
          setState({ status: "idle", suggestions: null });
          return;
        }
        setState({ status: "ready", suggestions });
      } catch {
        if (requestIdRef.current !== requestId) return;
        setState({ status: "error", suggestions: null });
      }
    })();
  }, [
    aiContext.outputLanguage,
    debouncedUrl,
    enabled,
    fetchSuggestions,
    open,
  ]);

  return { ...state, enabled };
}
