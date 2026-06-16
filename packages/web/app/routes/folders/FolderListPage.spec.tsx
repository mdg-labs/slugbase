import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { staticMessages } from "../../i18n/messages.js";
import type { FolderSharingSummary } from "../../components/sharing/sharing-recipients.utils.js";
import type { FolderListData, FolderListItem } from "./folders-loader.js";
import { PRIVATE_FOLDER_SHARING_SUMMARY } from "./folders-loader.js";
import { FolderListPage } from "./FolderListPage.js";
import { AppToastProvider } from "../../components/feedback/AppToastProvider.js";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      const messages = staticMessages.en as Record<string, string>;
      const template = messages[key] ?? key;
      return template.replace(/\{(\w+)\}/g, (_match: string, name: string) =>
        params?.[name] != null ? String(params[name]) : `{${name}}`,
      );
    },
  }),
}));

const mockNavigate = vi.fn();
let mockCanShare = false;
let mockCurrentUserId = "user-1";

vi.mock("react-router", () => ({
  Form: ({ children }: { children: React.ReactNode }) => <form>{children}</form>,
  useLoaderData: () => mockLoaderData,
  useNavigate: () => mockNavigate,
  useNavigation: () => ({ state: "idle" }),
  useRevalidator: () => ({ revalidate: vi.fn(), state: "idle" }),
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}));

vi.mock("../../components/sharing/use-workspace-entitlements.js", () => ({
  useWorkspaceEntitlements: () => ({
    currentUserId: mockCurrentUserId,
    canShare: mockCanShare,
  }),
}));

vi.mock("../../components/sharing/CompactShareModal.js", () => ({
  CompactShareModal: ({
    open,
    resourceTitle,
  }: {
    open: boolean;
    resourceTitle: string;
  }) =>
    open ? (
      <div data-testid="compact-share-modal">{resourceTitle}</div>
    ) : null,
}));

vi.mock("./folders-api.js", () => ({
  createFolder: vi.fn(),
  renameFolder: vi.fn(),
  deleteFolder: vi.fn(),
}));

const VIEW_STORAGE_KEY = "sb:folders:view";

let mockLoaderData: FolderListData;

const makeFolder = (overrides: Partial<FolderListItem> = {}): FolderListItem => ({
  id: "folder-1",
  userId: "user-1",
  name: "Reading List",
  icon: "book",
  color: "#7782f7",
  bookmarkCount: 12,
  sharingSummary: PRIVATE_FOLDER_SHARING_SUMMARY,
  updatedAt: "2026-06-01T10:00:00Z",
  ...overrides,
});

const baseData: FolderListData = {
  scope: "all",
  q: "",
  page: 1,
  pageSize: 12,
  sort: "name-asc",
  total: 1,
  items: [makeFolder()],
  ownerNames: {},
};

function renderPage() {
  return render(
    <AppToastProvider>
      <FolderListPage />
    </AppToastProvider>,
  );
}

describe("FolderListPage", () => {
  beforeEach(() => {
    mockLoaderData = { ...baseData };
    mockCanShare = false;
    mockCurrentUserId = "user-1";
    localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  describe("view toggle", () => {
    it("switches between list and grid layouts", () => {
      renderPage();

      expect(screen.getByTestId("folder-list")).toBeTruthy();
      expect(screen.queryByTestId("folder-grid")).toBeNull();

      fireEvent.click(screen.getByTitle("Grid view"));

      expect(screen.getByTestId("folder-grid")).toBeTruthy();
      expect(screen.getByTestId("folder-grid-item-folder-1")).toBeTruthy();
      expect(screen.queryByTestId("folder-list")).toBeNull();

      fireEvent.click(screen.getByTitle("List view"));

      expect(screen.getByTestId("folder-list")).toBeTruthy();
      expect(screen.queryByTestId("folder-grid")).toBeNull();
    });

    it("persists view mode in localStorage across reloads", () => {
      renderPage();

      fireEvent.click(screen.getByTitle("Grid view"));
      expect(localStorage.getItem(VIEW_STORAGE_KEY)).toBe("grid");

      cleanup();
      renderPage();

      expect(screen.getByTestId("folder-grid")).toBeTruthy();
      expect(screen.queryByTestId("folder-list")).toBeNull();
    });
  });

  describe("Sharing recipients badge", () => {
    it("shows sharing badge on list row when folder is shared by me", () => {
      const sharingSummary: FolderSharingSummary = {
        scope: "shared-by-me",
        directRecipients: [{ kind: "user", targetId: "u2", targetName: "Alice" }],
      };

      mockLoaderData = {
        ...baseData,
        items: [makeFolder({ sharingSummary })],
      };

      renderPage();

      const row = screen.getByTestId("folder-list-item-folder-1");
      expect(row.querySelector('[data-testid="sharing-recipients-badge"]')?.textContent).toContain(
        "Shared with 1",
      );
    });

    it("shows shared-with-you badge and owner label for shared-with-me folders", () => {
      const sharingSummary: FolderSharingSummary = {
        scope: "shared-with-me",
        directRecipients: [],
        accessPath: {
          kind: "direct",
          ownerName: "Sarah K.",
        },
      };

      mockLoaderData = {
        ...baseData,
        scope: "shared-with-me",
        items: [
          makeFolder({
            id: "folder-2",
            userId: "other-user",
            sharingSummary,
          }),
        ],
        ownerNames: { "other-user": "Sarah K." },
      };

      renderPage();

      const row = screen.getByTestId("folder-list-item-folder-2");
      expect(row.textContent).toContain("Sarah K.");
      expect(row.querySelector('[data-testid="sharing-recipients-badge"]')?.textContent).toContain(
        "Shared with you",
      );
    });

    it("shows sharing badge on grid card when folder is shared by me", () => {
      const sharingSummary: FolderSharingSummary = {
        scope: "shared-by-me",
        directRecipients: [
          { kind: "user", targetId: "u2", targetName: "Alice" },
          { kind: "team", targetId: "t1", targetName: "Design Team" },
        ],
      };

      mockLoaderData = {
        ...baseData,
        items: [makeFolder({ sharingSummary })],
      };

      renderPage();
      fireEvent.click(screen.getByTitle("Grid view"));

      const card = screen.getByTestId("folder-grid-item-folder-1");
      expect(card.querySelector('[data-testid="sharing-recipients-badge"]')?.textContent).toContain(
        "Shared with 2",
      );
    });
  });

  describe("share menu", () => {
    async function openRowMenu() {
      fireEvent.pointerDown(screen.getByLabelText("More options"));
      await waitFor(() => {
        expect(screen.getByText("Rename")).toBeTruthy();
      });
    }

    it("shows share action in row menu for entitled owners", async () => {
      mockCanShare = true;
      mockLoaderData = {
        ...baseData,
        items: [makeFolder()],
      };

      renderPage();
      await openRowMenu();

      expect(screen.getByTestId("folder-row-share-folder-1")).toBeTruthy();
    });

    it("opens compact share modal from row menu", async () => {
      mockCanShare = true;
      mockLoaderData = {
        ...baseData,
        items: [makeFolder({ name: "Team Docs" })],
      };

      renderPage();
      await openRowMenu();
      fireEvent.click(screen.getByTestId("folder-row-share-folder-1"));

      expect(screen.getByTestId("compact-share-modal").textContent).toBe("Team Docs");
    });
  });
});
