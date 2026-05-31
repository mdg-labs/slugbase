import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { staticMessages } from "../../i18n/messages.js";
import { ShareControls } from "./ShareControls.js";

vi.mock("@tolgee/react", () => ({
  useTranslate: () => ({
    t: (key: string) => {
      const messages = staticMessages.en as Record<string, string>;
      return messages[key] ?? key;
    },
  }),
}));

const { useWorkspaceEntitlementsMock } = vi.hoisted(() => ({
  useWorkspaceEntitlementsMock: vi.fn(),
}));

vi.mock("./use-workspace-entitlements.js", () => ({
  useWorkspaceEntitlements: useWorkspaceEntitlementsMock,
}));

vi.mock("./ShareDialog.js", () => ({
  ShareDialog: ({
    open,
    resourceKind,
    resourceId,
  }: {
    open: boolean;
    resourceKind: string;
    resourceId: string;
  }) =>
    open ? (
      <div data-testid={`share-dialog-${resourceKind}-${resourceId}`}>Share dialog</div>
    ) : null,
}));

describe("ShareControls", () => {
  afterEach(() => {
    cleanup();
    useWorkspaceEntitlementsMock.mockReset();
  });

  it("renders share action for owned folders when sharing is entitled", () => {
    useWorkspaceEntitlementsMock.mockReturnValue({
      canShare: true,
      currentUserId: "user-1",
    });

    const view = render(
      <ShareControls
        resourceKind="folder"
        resourceId="folder-1"
        resourceTitle="Reading"
        ownerUserId="user-1"
      />,
    );

    expect(view.getByTestId("share-controls-folder-folder-1")).toBeTruthy();
  });

  it("hides share action for folders owned by another member", () => {
    useWorkspaceEntitlementsMock.mockReturnValue({
      canShare: true,
      currentUserId: "user-1",
    });

    const view = render(
      <ShareControls
        resourceKind="folder"
        resourceId="folder-2"
        resourceTitle="Shared reading"
        ownerUserId="user-2"
      />,
    );

    expect(view.queryByTestId("share-controls-folder-folder-2")).toBeNull();
  });

  it("opens folder share dialog when share action is clicked", async () => {
    useWorkspaceEntitlementsMock.mockReturnValue({
      canShare: true,
      currentUserId: "user-1",
    });

    const view = render(
      <ShareControls
        resourceKind="folder"
        resourceId="folder-1"
        resourceTitle="Reading"
        ownerUserId="user-1"
      />,
    );

    fireEvent.click(view.getByTestId("share-controls-folder-folder-1"));

    await waitFor(() => {
      expect(view.getByTestId("share-dialog-folder-folder-1")).toBeTruthy();
    });
  });
});
