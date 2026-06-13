import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider, ToastProvider } from "@slugbase/ui";

import { staticMessages } from "../../i18n/messages.js";
import { ForwardingPage } from "./ForwardingPage.js";
import type { ForwardingLoaderData } from "./forwarding-loader.js";
import * as forwardingApi from "./forwarding-api.js";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      const messages = staticMessages.en as Record<string, string>;
      const template = messages[key] ?? key;
      if (!params) return template;
      return Object.entries(params).reduce(
        (value, [name, replacement]) =>
          value.replaceAll(`{${name}}`, String(replacement)),
        template,
      );
    },
  }),
}));

const mockRevalidate = vi.fn();

const loaderData = vi.hoisted((): { value: ForwardingLoaderData } => ({
  value: {
    currentUserId: "user-1",
    ownerNames: { "user-2": "Jamie Lee" },
    items: [
      {
        id: "pref-1",
        workspaceId: "ws-1",
        userId: "user-1",
        slug: "docs",
        bookmarkId: "bm-1",
        createdAt: "2026-06-01T12:00:00.000Z",
        bookmarkTitle: "React docs",
        bookmarkUrl: "https://react.dev",
        ownerUserId: "user-1",
        isAmbiguous: false,
      },
      {
        id: "pref-2",
        workspaceId: "ws-1",
        userId: "user-1",
        slug: "mail",
        bookmarkId: "bm-2",
        createdAt: "2026-06-02T12:00:00.000Z",
        bookmarkTitle: "Shared inbox",
        bookmarkUrl: "https://mail.example.com",
        ownerUserId: "user-2",
        isAmbiguous: true,
      },
    ],
  },
}));

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    useLoaderData: () => loaderData.value,
    useRevalidator: () => ({ revalidate: mockRevalidate, state: "idle" }),
  };
});

function renderPage(data?: ForwardingLoaderData) {
  if (data) {
    loaderData.value = data;
  }

  return render(
    <ThemeProvider>
      <ToastProvider dismissLabel="Dismiss">
        <ForwardingPage />
      </ToastProvider>
    </ThemeProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  mockRevalidate.mockReset();
  loaderData.value = {
    currentUserId: "user-1",
    ownerNames: { "user-2": "Jamie Lee" },
    items: [
      {
        id: "pref-1",
        workspaceId: "ws-1",
        userId: "user-1",
        slug: "docs",
        bookmarkId: "bm-1",
        createdAt: "2026-06-01T12:00:00.000Z",
        bookmarkTitle: "React docs",
        bookmarkUrl: "https://react.dev",
        ownerUserId: "user-1",
        isAmbiguous: false,
      },
      {
        id: "pref-2",
        workspaceId: "ws-1",
        userId: "user-1",
        slug: "mail",
        bookmarkId: "bm-2",
        createdAt: "2026-06-02T12:00:00.000Z",
        bookmarkTitle: "Shared inbox",
        bookmarkUrl: "https://mail.example.com",
        ownerUserId: "user-2",
        isAmbiguous: true,
      },
    ],
  };
});

describe("ForwardingPage", () => {
  beforeEach(() => {
    vi.spyOn(forwardingApi, "deleteSlugPreference").mockResolvedValue(undefined);
    vi.spyOn(forwardingApi, "fetchDisambiguationCandidates").mockResolvedValue([
      {
        id: "bm-2",
        title: "Shared inbox",
        url: "https://mail.example.com",
        ownerUserId: "user-2",
      },
      {
        id: "bm-3",
        title: "Team mail",
        url: "https://team-mail.example.com",
        ownerUserId: "user-1",
      },
    ]);
    vi.spyOn(forwardingApi, "updateSlugPreference").mockResolvedValue(undefined);
  });

  it("renders the preference list with slug and bookmark details", () => {
    const view = renderPage();

    expect(view.getByTestId("forwarding-prefs-list")).toBeTruthy();
    expect(view.getByText("docs")).toBeTruthy();
    expect(view.getByText("React docs")).toBeTruthy();
    expect(view.getByText("Shared inbox")).toBeTruthy();
    expect(view.getByText("Owner: Jamie Lee")).toBeTruthy();
    expect(view.getByTestId("forwarding-pref-delete-pref-1")).toBeTruthy();
    expect(view.queryByTestId("forwarding-pref-edit-pref-1")).toBeNull();
    expect(view.getByTestId("forwarding-pref-edit-pref-2")).toBeTruthy();
  });

  it("renders the empty state when there are no preferences", () => {
    const view = renderPage({
      currentUserId: "user-1",
      ownerNames: {},
      items: [],
    });

    expect(view.getByTestId("forwarding-prefs-empty")).toBeTruthy();
    expect(view.getByText("No remembered preferences")).toBeTruthy();
  });

  it("calls delete API when confirming removal", async () => {
    const view = renderPage();

    fireEvent.click(view.getByTestId("forwarding-pref-delete-pref-1"));

    await waitFor(() => {
      expect(view.getByTestId("forwarding-pref-delete-dialog")).toBeTruthy();
    });

    const dialog = view.getByTestId("forwarding-pref-delete-dialog");
    const buttons = dialog.querySelectorAll("button");
    const confirmButton = buttons[buttons.length - 1];
    expect(confirmButton).toBeTruthy();
    fireEvent.click(confirmButton as HTMLButtonElement);

    await waitFor(() => {
      expect(forwardingApi.deleteSlugPreference).toHaveBeenCalledWith("pref-1");
    });
    expect(mockRevalidate).toHaveBeenCalled();
  });

  it("opens the candidate picker when editing an ambiguous preference", async () => {
    const view = renderPage();

    fireEvent.click(view.getByTestId("forwarding-pref-edit-pref-2"));

    await waitFor(() => {
      expect(forwardingApi.fetchDisambiguationCandidates).toHaveBeenCalledWith("mail");
      expect(view.getByTestId("forwarding-pref-edit-dialog")).toBeTruthy();
    });

    fireEvent.click(view.getByTestId("forwarding-pref-edit-candidate-bm-3"));

    const dialog = view.getByTestId("forwarding-pref-edit-dialog");
    const buttons = dialog.querySelectorAll("button");
    const saveButton = buttons[buttons.length - 1];
    expect(saveButton).toBeTruthy();
    fireEvent.click(saveButton as HTMLButtonElement);

    await waitFor(() => {
      expect(forwardingApi.updateSlugPreference).toHaveBeenCalledWith("mail", "bm-3");
    });
  });
});
