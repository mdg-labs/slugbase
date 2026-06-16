import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { staticMessages } from "../../i18n/messages.js";
import { SharingRecipientsBadge } from "./SharingRecipientsBadge.js";
import type {
  BookmarkSharingSummary,
  FolderSharingSummary,
} from "./sharing-recipients.utils.js";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      const template = (staticMessages.en as Record<string, string>)[key] ?? key;
      if (!params) {
        return template;
      }
      return Object.entries(params).reduce(
        (value, [name, paramValue]) =>
          value.replace(new RegExp(`\\{${name}\\}`, "g"), String(paramValue)),
        template,
      );
    },
  }),
}));

const ownedBookmarkSummary: BookmarkSharingSummary = {
  scope: "shared-by-me",
  directRecipients: [
    { kind: "user", targetId: "u1", targetName: "Alice" },
    { kind: "team", targetId: "t1", targetName: "Design Team" },
  ],
  viaFolders: [
    {
      folderId: "f1",
      folderName: "Reading",
      recipients: [{ kind: "user", targetId: "u2", targetName: "Bob" }],
    },
    {
      folderId: "f2",
      folderName: "Research",
      recipients: [{ kind: "user", targetId: "u3", targetName: "Carol" }],
    },
  ],
};

const recipientBookmarkSummary: BookmarkSharingSummary = {
  scope: "shared-with-me",
  directRecipients: [],
  viaFolders: [],
  accessPath: {
    kind: "folder",
    ownerName: "Sarah K.",
    folderName: "Team Resources",
  },
};

const privateBookmarkSummary: BookmarkSharingSummary = {
  scope: "mine",
  directRecipients: [],
  viaFolders: [],
};

const ownedFolderSummary: FolderSharingSummary = {
  scope: "shared-by-me",
  directRecipients: [{ kind: "user", targetId: "u4", targetName: "Dave" }],
};

describe("SharingRecipientsBadge", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders nothing for private resources without shares", () => {
    const view = render(<SharingRecipientsBadge summary={privateBookmarkSummary} />);
    expect(view.queryByTestId("sharing-recipients-badge")).toBeNull();
  });

  it("shows owner badge label with effective share count", () => {
    const view = render(<SharingRecipientsBadge summary={ownedBookmarkSummary} />);
    expect(view.getByTestId("sharing-recipients-badge").textContent).toContain(
      "Shared with 4",
    );
  });

  it("truncates tooltip recipient names to five with overflow count", async () => {
    const summary: BookmarkSharingSummary = {
      scope: "shared-by-me",
      directRecipients: [
        { kind: "user", targetId: "u1", targetName: "One" },
        { kind: "user", targetId: "u2", targetName: "Two" },
        { kind: "user", targetId: "u3", targetName: "Three" },
        { kind: "user", targetId: "u4", targetName: "Four" },
      ],
      viaFolders: [
        {
          folderId: "f1",
          folderName: "Alpha",
          recipients: [
            { kind: "user", targetId: "u5", targetName: "Five" },
            { kind: "user", targetId: "u6", targetName: "Six" },
            { kind: "user", targetId: "u7", targetName: "Seven" },
          ],
        },
      ],
    };

    const view = render(<SharingRecipientsBadge summary={summary} />);
    fireEvent.focus(view.getByTestId("sharing-recipients-badge"));

    await waitFor(() => {
      const tooltip = view.getByTestId("sharing-recipients-tooltip");
      expect(tooltip.textContent).toContain("One, Two, Three, Four, Five");
      expect(tooltip.textContent).toContain("+2 more");
    });
  });

  it("opens popover with grouped direct and via-folder sections", async () => {
    const view = render(<SharingRecipientsBadge summary={ownedBookmarkSummary} />);
    fireEvent.click(view.getByTestId("sharing-recipients-badge"));

    await waitFor(() => {
      const popover = view.getByTestId("sharing-recipients-popover");
      expect(popover.textContent).toContain("Direct access");
      expect(popover.textContent).toContain("Alice");
      expect(popover.textContent).toContain("Design Team");
      expect(popover.textContent).toContain("Via folder Reading");
      expect(popover.textContent).toContain("Bob");
      expect(popover.textContent).toContain("Via folder Research");
      expect(popover.textContent).toContain("Carol");
    });
  });

  it("shows recipient access path in tooltip and popover", async () => {
    const view = render(<SharingRecipientsBadge summary={recipientBookmarkSummary} />);

    expect(view.getByTestId("sharing-recipients-badge").textContent).toContain(
      "Shared with you",
    );

    fireEvent.focus(view.getByTestId("sharing-recipients-badge"));
    await waitFor(() => {
      expect(view.getByTestId("sharing-recipients-tooltip").textContent).toContain(
        "Shared by Sarah K. via folder Team Resources",
      );
    });

    fireEvent.click(view.getByTestId("sharing-recipients-badge"));
    await waitFor(() => {
      expect(view.getByTestId("sharing-recipients-popover").textContent).toContain(
        "Shared by Sarah K. via folder Team Resources",
      );
    });
  });

  it("opens popover from keyboard Enter on the trigger", async () => {
    const view = render(<SharingRecipientsBadge summary={ownedFolderSummary} />);
    const trigger = view.getByTestId("sharing-recipients-badge");

    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter", code: "Enter" });

    await waitFor(() => {
      expect(view.getByTestId("sharing-recipients-popover")).toBeTruthy();
      expect(view.getByTestId("sharing-recipients-popover").textContent).toContain(
        "Dave",
      );
    });
  });
});
