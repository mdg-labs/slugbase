import { describe, expect, it } from "vitest";

import { canRequestBookmarkModalAiSuggestions } from "./bookmark-modal-ai-gates.js";
import type { BookmarkModalAiContext } from "./bookmark-modal-ai.types.js";

const base: BookmarkModalAiContext = {
  hasAiEntitlement: true,
  workspaceAiEnabled: true,
  userAiOptOut: false,
  aiProviderAvailable: true,
  outputLanguage: "en",
};

describe("canRequestBookmarkModalAiSuggestions", () => {
  it("returns false without entitlement", () => {
    expect(
      canRequestBookmarkModalAiSuggestions({
        ...base,
        hasAiEntitlement: false,
      }),
    ).toBe(false);
  });

  it("returns false when workspace AI is disabled", () => {
    expect(
      canRequestBookmarkModalAiSuggestions({
        ...base,
        workspaceAiEnabled: false,
      }),
    ).toBe(false);
  });

  it("returns false when the user opted out", () => {
    expect(
      canRequestBookmarkModalAiSuggestions({
        ...base,
        userAiOptOut: true,
      }),
    ).toBe(false);
  });

  it("returns true when all gates pass", () => {
    expect(canRequestBookmarkModalAiSuggestions(base)).toBe(true);
  });
});
