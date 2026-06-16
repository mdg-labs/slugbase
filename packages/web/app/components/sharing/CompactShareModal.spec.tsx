import { cleanup, createEvent, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { staticMessages } from "../../i18n/messages.js";
import { CompactShareModal } from "./CompactShareModal.js";
import { canShowShareMenu } from "./share-menu.utils.js";

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

const {
  fetchResourceSharesMock,
  grantResourceShareMock,
  revokeResourceShareMock,
} = vi.hoisted(() => ({
  fetchResourceSharesMock: vi.fn(),
  grantResourceShareMock: vi.fn(),
  revokeResourceShareMock: vi.fn(),
}));

vi.mock("./sharing-api.js", () => ({
  fetchShareTargets: vi.fn(() =>
    Promise.resolve({
      members: [{ userId: "user-2", name: "Alex Member", email: "alex@example.com" }],
      teams: [{ id: "team-1", name: "Design", memberCount: 3 }],
    }),
  ),
  fetchResourceShares: fetchResourceSharesMock,
  grantResourceShare: grantResourceShareMock,
  revokeResourceShare: revokeResourceShareMock,
}));

describe("CompactShareModal", () => {
  beforeEach(() => {
    fetchResourceSharesMock.mockResolvedValue([
      {
        id: "grant-existing",
        kind: "user",
        targetId: "user-3",
        targetName: "Jamie Member",
        createdAt: "2026-05-31T12:00:00.000Z",
      },
    ]);
    grantResourceShareMock.mockResolvedValue({
      id: "grant-new",
      kind: "user",
      targetId: "user-2",
      targetName: "Alex Member",
      createdAt: "2026-05-31T12:00:00.000Z",
    });
    revokeResourceShareMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  it("renders grants list after loading", async () => {
    const view = render(
      <CompactShareModal
        open
        onOpenChange={vi.fn()}
        resourceKind="bookmark"
        resourceId="bookmark-1"
        resourceTitle="Example docs"
      />,
    );

    await waitFor(() => {
      expect(view.getByTestId("compact-share-modal")).toBeTruthy();
      expect(view.getByTestId("compact-share-modal-grant-grant-existing")).toBeTruthy();
      expect(view.getByText("Jamie Member")).toBeTruthy();
    });
  });

  it("grants access to a selected member", async () => {
    const onUpdated = vi.fn();
    const view = render(
      <CompactShareModal
        open
        onOpenChange={vi.fn()}
        resourceKind="folder"
        resourceId="folder-1"
        resourceTitle="Reading list"
        onUpdated={onUpdated}
      />,
    );

    await waitFor(() => {
      expect(view.getByTestId("compact-share-modal-grant-grant-existing")).toBeTruthy();
    });

    const select = view.getByTestId(
      "compact-share-modal-target-select",
    ) as HTMLSelectElement;
    fireEvent(
      select,
      createEvent.change(select, { target: { value: "user-2" } }),
    );

    await waitFor(() => {
      const grantButton = view.getByTestId(
        "compact-share-modal-grant-button",
      ) as HTMLButtonElement;
      expect(grantButton.disabled).toBe(false);
    });

    fireEvent.click(view.getByTestId("compact-share-modal-grant-button"));

    await waitFor(() => {
      expect(grantResourceShareMock).toHaveBeenCalledWith(
        "folder",
        "folder-1",
        "user",
        "user-2",
      );
      expect(onUpdated).toHaveBeenCalled();
    });
  });

  describe("share menu visibility", () => {
    it("shows share menu for entitled owners", () => {
      expect(canShowShareMenu(true, "user-1", "user-1")).toBe(true);
    });

    it("hides share menu for recipients", () => {
      expect(canShowShareMenu(true, "user-2", "user-1")).toBe(false);
    });

    it("hides share menu when team-sharing is gated", () => {
      expect(canShowShareMenu(false, "user-1", "user-1")).toBe(false);
    });
  });

  it("revokes an existing grant", async () => {
    const onUpdated = vi.fn();
    const view = render(
      <CompactShareModal
        open
        onOpenChange={vi.fn()}
        resourceKind="bookmark"
        resourceId="bookmark-1"
        resourceTitle="Example docs"
        onUpdated={onUpdated}
      />,
    );

    await waitFor(() => {
      const revokeButton = view.getByTestId(
        "compact-share-modal-revoke-grant-existing",
      ) as HTMLButtonElement;
      expect(revokeButton.disabled).toBe(false);
    });

    fireEvent.click(view.getByTestId("compact-share-modal-revoke-grant-existing"));

    await waitFor(() => {
      expect(revokeResourceShareMock).toHaveBeenCalledWith(
        "bookmark",
        "bookmark-1",
        "grant-existing",
      );
      expect(onUpdated).toHaveBeenCalled();
    });
  });
});
