import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { staticMessages } from "../../i18n/messages.js";
import type { FolderListData, FolderListItem } from "./folders-loader.js";
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
    currentUserId: "user-1",
    canShare: false,
  }),
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
  shareGrantCount: 0,
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
});
