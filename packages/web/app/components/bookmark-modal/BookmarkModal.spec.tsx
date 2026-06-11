import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { staticMessages } from "../../i18n/messages.js";
import { BookmarkModal } from "./BookmarkModal.js";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      const messages = staticMessages.en as Record<string, string>;
      const template = messages[key] ?? key;
      return template.replace(/\{(\w+)\}/g, (_match, name: string) =>
        params?.[name] != null ? String(params[name]) : `{${name}}`,
      );
    },
  }),
}));

vi.mock("../sharing/use-workspace-entitlements.js", () => ({
  useWorkspaceEntitlements: () => ({
    workspace: { id: "ws-1", name: "Personal", plan: "personal" },
    currentUserId: "user-1",
    canShare: true,
  }),
}));

const folders = [{ id: "folder-1", name: "Reading", icon: "book" }];
const tags = [{ id: "tag-1", name: "research" }];

describe("BookmarkModal", () => {
  afterEach(() => {
    cleanup();
  });

  it("surfaces validation errors when required fields are missing", async () => {
    const onSubmit = vi.fn();
    const view = render(
      <BookmarkModal
        open
        onOpenChange={vi.fn()}
        mode="create"
        folders={folders}
        tags={tags}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.click(view.getByRole("button", { name: "Save bookmark" }));

    await waitFor(() => {
      expect(view.getByText("Enter a destination URL.")).toBeTruthy();
      expect(view.getByText("Enter a title.")).toBeTruthy();
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("requires a slug when forwarding is enabled", async () => {
    const onSubmit = vi.fn();
    const view = render(
      <BookmarkModal
        open
        onOpenChange={vi.fn()}
        mode="create"
        folders={folders}
        tags={tags}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(view.getByLabelText("URL"), {
      target: { value: "https://example.com" },
    });
    fireEvent.change(view.getByLabelText("Title"), {
      target: { value: "Example" },
    });
    fireEvent.click(view.getByRole("checkbox", { name: "Enable forwarding" }));

    fireEvent.click(view.getByRole("button", { name: "Save bookmark" }));

    await waitFor(() => {
      expect(
        view.getByText("A slug is required when forwarding is enabled."),
      ).toBeTruthy();
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits create payload when the form is valid", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onOpenChange = vi.fn();
    const view = render(
      <BookmarkModal
        open
        onOpenChange={onOpenChange}
        mode="create"
        folders={folders}
        tags={tags}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(view.getByLabelText("URL"), {
      target: { value: "https://example.com/docs" },
    });
    fireEvent.change(view.getByLabelText("Title"), {
      target: { value: "Example docs" },
    });
    fireEvent.change(view.getByLabelText("Slug"), {
      target: { value: "docs" },
    });

    // Select folder via dropdown
    fireEvent.click(view.getByTestId("folder-selector-trigger"));
    await waitFor(() => {
      expect(view.getByTestId("folder-selector-menu")).toBeTruthy();
    });
    fireEvent.click(view.getByRole("option", { name: "Reading" }));

    // Select tag via suggestion list
    const input = view.getByTestId("tag-input");
    fireEvent.focus(input);
    await waitFor(() => {
      expect(view.getByTestId("tag-suggestions")).toBeTruthy();
    });
    fireEvent.mouseDown(view.getByRole("option", { name: /research/ }));

    fireEvent.click(view.getByRole("checkbox", { name: "Pin bookmark" }));

    fireEvent.click(view.getByRole("button", { name: "Save bookmark" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        mode: "create",
        url: "https://example.com/docs",
        title: "Example docs",
        slug: "docs",
        folderIds: ["folder-1"],
        newFolderNames: [],
        tagIds: ["tag-1"],
        newTagNames: [],
        pinned: true,
        forwardingEnabled: false,
        bookmarkId: undefined,
      });
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("prefills edit values and submits an update", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const view = render(
      <BookmarkModal
        open
        onOpenChange={vi.fn()}
        mode="edit"
        bookmark={{
          id: "bm-1",
          title: "Old title",
          url: "https://old.example",
          slug: "old",
          forwardingEnabled: true,
          pinned: false,
          folderIds: ["folder-1"],
          tagIds: [],
        }}
        folders={folders}
        tags={tags}
        onSubmit={onSubmit}
      />,
    );

    expect((view.getByLabelText("Title") as HTMLInputElement).value).toBe(
      "Old title",
    );

    fireEvent.change(view.getByLabelText("Title"), {
      target: { value: "Updated title" },
    });
    fireEvent.click(view.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        mode: "edit",
        bookmarkId: "bm-1",
        url: "https://old.example",
        title: "Updated title",
        slug: "old",
        folderIds: ["folder-1"],
        newFolderNames: [],
        tagIds: [],
        newTagNames: [],
        pinned: false,
        forwardingEnabled: true,
      });
    });
  });

  it("creates tag pills from typing and Enter key", async () => {
    const view = render(
      <BookmarkModal
        open
        onOpenChange={vi.fn()}
        mode="create"
        folders={folders}
        tags={tags}
        onSubmit={vi.fn()}
      />,
    );

    const input = view.getByTestId("tag-input");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "newtag" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // New tag pill should appear
    await waitFor(() => {
      expect(view.getByText("newtag")).toBeTruthy();
      expect(view.getByTestId("tag-remove-new-newtag")).toBeTruthy();
    });

    // Input should be cleared
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("removes tags via pill X button", async () => {
    const view = render(
      <BookmarkModal
        open
        onOpenChange={vi.fn()}
        mode="create"
        folders={folders}
        tags={tags}
        onSubmit={vi.fn()}
      />,
    );

    // Add a new tag first
    const input = view.getByTestId("tag-input");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "test" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(view.getByTestId("tag-remove-new-test")).toBeTruthy();
    });

    // Remove it via X button
    fireEvent.click(view.getByTestId("tag-remove-new-test"));

    await waitFor(() => {
      expect(view.queryByTestId("tag-remove-new-test")).toBeNull();
    });
  });

  it("removes tags via Backspace on empty input", async () => {
    const view = render(
      <BookmarkModal
        open
        onOpenChange={vi.fn()}
        mode="create"
        folders={folders}
        tags={tags}
        onSubmit={vi.fn()}
      />,
    );

    // Add a new tag
    const input = view.getByTestId("tag-input");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "test" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(view.getByTestId("tag-remove-new-test")).toBeTruthy();
    });

    // Press Backspace on empty input to remove last tag
    fireEvent.keyDown(input, { key: "Backspace" });

    await waitFor(() => {
      expect(view.queryByTestId("tag-remove-new-test")).toBeNull();
    });
  });

  it("shows tag input even when no tags exist", () => {
    const view = render(
      <BookmarkModal
        open
        onOpenChange={vi.fn()}
        mode="create"
        folders={[]}
        tags={[]}
        onSubmit={vi.fn()}
      />,
    );

    // Tag input should always be present in the DOM
    const input = view.getByTestId("tag-input");
    expect(input).toBeTruthy();
    expect(input.getAttribute("data-testid")).toBe("tag-input");
  });

  it("opens folder dropdown and shows create trigger", async () => {
    const view = render(
      <BookmarkModal
        open
        onOpenChange={vi.fn()}
        mode="create"
        folders={folders}
        tags={tags}
        onSubmit={vi.fn()}
      />,
    );

    fireEvent.click(view.getByTestId("folder-selector-trigger"));

    await waitFor(() => {
      expect(view.getByTestId("folder-selector-menu")).toBeTruthy();
      expect(view.getByTestId("folder-create-trigger")).toBeTruthy();
    });
  });

  it("shows nested create-folder subflow inside dropdown", async () => {
    const view = render(
      <BookmarkModal
        open
        onOpenChange={vi.fn()}
        mode="create"
        folders={folders}
        tags={tags}
        onSubmit={vi.fn()}
      />,
    );

    // Open folder dropdown
    fireEvent.click(view.getByTestId("folder-selector-trigger"));
    await waitFor(() => {
      expect(view.getByTestId("folder-create-trigger")).toBeTruthy();
    });

    // Click the create trigger
    fireEvent.click(view.getByTestId("folder-create-trigger"));

    await waitFor(() => {
      expect(view.getByTestId("folder-create-name-input")).toBeTruthy();
      expect(view.getByTestId("folder-create-confirm")).toBeTruthy();
    });

    // Type a name and confirm
    fireEvent.change(view.getByTestId("folder-create-name-input"), {
      target: { value: "New Folder" },
    });
    fireEvent.click(view.getByTestId("folder-create-confirm"));

    // Dropdown should close and form should have the new folder name
    await waitFor(() => {
      expect(view.queryByTestId("folder-selector-menu")).toBeNull();
    });
  });

  it("selects and deselects existing folders via dropdown", async () => {
    const view = render(
      <BookmarkModal
        open
        onOpenChange={vi.fn()}
        mode="create"
        folders={folders}
        tags={tags}
        onSubmit={vi.fn()}
      />,
    );

    // Open dropdown
    fireEvent.click(view.getByTestId("folder-selector-trigger"));
    await waitFor(() => {
      expect(view.getByTestId("folder-selector-menu")).toBeTruthy();
    });

    // Select the folder (multi-select: dropdown stays open)
    fireEvent.click(view.getByRole("option", { name: "Reading" }));

    // Dropdown stays open for multi-select - deselect immediately
    await waitFor(() => {
      expect(view.getByTestId("folder-selector-menu")).toBeTruthy();
    });
    fireEvent.click(view.getByRole("option", { name: "Reading" }));

    // Still open after deselect
    await waitFor(() => {
      expect(view.getByTestId("folder-selector-menu")).toBeTruthy();
    });

    // Close by clicking trigger
    fireEvent.click(view.getByTestId("folder-selector-trigger"));
    await waitFor(() => {
      expect(view.queryByTestId("folder-selector-menu")).toBeNull();
    });
  });
});
