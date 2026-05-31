import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { staticMessages } from "../../i18n/messages.js";
import { BookmarkModal } from "./BookmarkModal.js";

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
    fireEvent.click(view.getByLabelText("Reading"));
    fireEvent.click(view.getByLabelText("research"));
    fireEvent.click(view.getByRole("checkbox", { name: "Pin bookmark" }));

    fireEvent.click(view.getByRole("button", { name: "Save bookmark" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        mode: "create",
        url: "https://example.com/docs",
        title: "Example docs",
        slug: "docs",
        folderIds: ["folder-1"],
        tagIds: ["tag-1"],
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
        tagIds: [],
        pinned: false,
        forwardingEnabled: true,
      });
    });
  });
});
