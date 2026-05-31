import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { staticMessages } from "../../../i18n/messages.js";
import { BookmarkModal } from "../BookmarkModal.js";
import type { BookmarkModalSubmitPayload } from "../bookmark-modal.types.js";
import type { BookmarkModalAiContext } from "./bookmark-modal-ai.types.js";

vi.mock("@tolgee/react", () => ({
  useTranslate: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      const messages = staticMessages.en as Record<string, string>;
      const template = messages[key] ?? key;
      return template.replace(/\{(\w+)\}/g, (_match, name: string) =>
        params?.[name] != null ? String(params[name]) : `{${name}}`,
      );
    },
  }),
}));

vi.mock("../../sharing/use-workspace-entitlements.js", () => ({
  useWorkspaceEntitlements: () => ({
    workspace: { id: "ws-1", name: "Personal", plan: "personal" },
    currentUserId: "user-1",
    canShare: true,
  }),
}));

const folders = [{ id: "folder-1", name: "Reading", icon: "book" }];
const tags = [
  { id: "tag-1", name: "research" },
  { id: "tag-2", name: "docs" },
];

const enabledAiContext: BookmarkModalAiContext = {
  hasAiEntitlement: true,
  workspaceAiEnabled: true,
  userAiOptOut: false,
  aiProviderAvailable: true,
  outputLanguage: "de",
};

const mockSuggestions = {
  title: "Example documentation",
  slug: "example-docs",
  tags: ["research", "docs"],
  detectedLanguage: "en",
  confidence: 0.9,
};

describe("BookmarkModal AI suggestions", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("shows inline suggestions and applies them", async () => {
    const fetchAiSuggestions = vi.fn().mockResolvedValue(mockSuggestions);
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const view = render(
      <BookmarkModal
        open
        onOpenChange={vi.fn()}
        mode="create"
        folders={folders}
        tags={tags}
        onSubmit={onSubmit}
        aiContext={enabledAiContext}
        fetchAiSuggestions={fetchAiSuggestions}
      />,
    );

    fireEvent.change(view.getByLabelText("URL"), {
      target: { value: "https://example.com/docs" },
    });

    await vi.advanceTimersByTimeAsync(500);

    await waitFor(() => {
      expect(fetchAiSuggestions).toHaveBeenCalledWith({
        url: "https://example.com/docs",
        outputLanguage: "de",
      });
    });

    await waitFor(() => {
      expect(view.getAllByTestId("bookmark-modal-ai-suggestion")).toHaveLength(2);
    });

    const applyButtons = view.getAllByRole("button", { name: "Apply" });
    fireEvent.click(applyButtons[0] as HTMLButtonElement);
    fireEvent.click(applyButtons[1] as HTMLButtonElement);

    expect((view.getByLabelText("Title") as HTMLInputElement).value).toBe(
      "Example documentation",
    );
    expect((view.getByLabelText("Slug") as HTMLInputElement).value).toBe(
      "example-docs",
    );

    fireEvent.click(view.getByRole("button", { name: "research" }));
    fireEvent.click(view.getByRole("button", { name: "docs" }));

    fireEvent.click(view.getByRole("button", { name: "Save bookmark" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalled();
    });
    const payload = onSubmit.mock.calls[0]?.[0] as BookmarkModalSubmitPayload;
    expect(payload.title).toBe("Example documentation");
    expect(payload.slug).toBe("example-docs");
    expect(payload.tagIds).toEqual(expect.arrayContaining(["tag-1", "tag-2"]));
  });

  it("short-circuits when the user opted out of AI", async () => {
    const fetchAiSuggestions = vi.fn().mockResolvedValue(mockSuggestions);
    const view = render(
      <BookmarkModal
        open
        onOpenChange={vi.fn()}
        mode="create"
        folders={folders}
        tags={tags}
        onSubmit={vi.fn()}
        aiContext={{
          ...enabledAiContext,
          userAiOptOut: true,
        }}
        fetchAiSuggestions={fetchAiSuggestions}
      />,
    );

    fireEvent.change(view.getByLabelText("URL"), {
      target: { value: "https://example.com/docs" },
    });

    await vi.advanceTimersByTimeAsync(500);

    await waitFor(() => {
      expect(fetchAiSuggestions).not.toHaveBeenCalled();
    });
    expect(view.queryByTestId("bookmark-modal-ai-suggestion")).toBeNull();
  });
});
