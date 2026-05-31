import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { staticMessages } from "../../i18n/messages.js";
import { ShareDialog } from "./ShareDialog.js";

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

const { fetchResourceSharesMock } = vi.hoisted(() => ({
  fetchResourceSharesMock: vi.fn(),
}));

vi.mock("./sharing-api.js", () => ({
  fetchShareTargets: vi.fn(() =>
    Promise.resolve({
      members: [{ userId: "user-2", name: "Alex Member", email: "alex@example.com" }],
      teams: [{ id: "team-1", name: "Design", memberCount: 3 }],
    }),
  ),
  fetchResourceShares: fetchResourceSharesMock,
  grantResourceShare: vi.fn(() =>
    Promise.resolve({
      id: "grant-1",
      kind: "user",
      targetId: "user-2",
      targetName: "Alex Member",
      createdAt: "2026-05-31T12:00:00.000Z",
    }),
  ),
  revokeResourceShare: vi.fn(() => Promise.resolve(undefined)),
}));

describe("ShareDialog", () => {
  beforeEach(() => {
    fetchResourceSharesMock.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
  });

  it("renders share targets after loading", async () => {
    const view = render(
      <ShareDialog
        open
        onOpenChange={vi.fn()}
        resourceKind="bookmark"
        resourceId="bookmark-1"
        resourceTitle="Example docs"
      />,
    );

    await waitFor(() => {
      expect(view.getByTestId("share-dialog")).toBeTruthy();
      expect(view.getByTestId("share-dialog-target-select")).toBeTruthy();
      expect(view.getByText("Alex Member")).toBeTruthy();
    });
  });
});
