/** Bookmark field suggestions returned by the AI suggest API (spec §11.2). */
export type BookmarkModalAiSuggestions = {
  title: string;
  slug: string;
  tags: string[];
  detectedLanguage: string;
  confidence: number;
};

/** Gating inputs for inline AI suggestions (spec §11.2, §12.4, §17). */
export type BookmarkModalAiContext = {
  /** Plan grants AI (off on Free). */
  hasAiEntitlement: boolean;
  /** Workspace admin enable toggle (spec §10.1). */
  workspaceAiEnabled: boolean;
  /** Per-user opt-out on `user_account` (spec §16). */
  userAiOptOut: boolean;
  /** Provider credential configured for this deployment/workspace. */
  aiProviderAvailable: boolean;
  /** Resolved user locale — ISO 639-1 (`en`, `de`) passed as `outputLanguage`. */
  outputLanguage: string;
};

export const DEFAULT_BOOKMARK_MODAL_AI_CONTEXT: BookmarkModalAiContext = {
  hasAiEntitlement: false,
  workspaceAiEnabled: false,
  userAiOptOut: false,
  aiProviderAvailable: false,
  outputLanguage: "en",
};

export type FetchAiSuggestionsParams = {
  url: string;
  outputLanguage: string;
};

export type FetchAiSuggestionsFn = (
  params: FetchAiSuggestionsParams,
) => Promise<BookmarkModalAiSuggestions | null>;

export type BookmarkModalAiSuggestionsState = {
  status: "idle" | "loading" | "ready" | "error";
  suggestions: BookmarkModalAiSuggestions | null;
};
