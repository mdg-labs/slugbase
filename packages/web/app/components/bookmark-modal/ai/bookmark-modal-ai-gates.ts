import type { BookmarkModalAiContext } from "./bookmark-modal-ai.types.js";

/** True when all gates allow requesting AI suggestions for the modal. */
export function canRequestBookmarkModalAiSuggestions(
  context: BookmarkModalAiContext,
): boolean {
  return (
    context.hasAiEntitlement &&
    context.workspaceAiEnabled &&
    !context.userAiOptOut &&
    context.aiProviderAvailable
  );
}
