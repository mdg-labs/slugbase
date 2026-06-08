import { ToastProvider } from "@slugbase/ui";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { staticMessages } from "../../../i18n/messages.js";
import { MembersPlanGate } from "./components/MembersPlanGate.js";
import { MembersSettingsPage } from "./components/MembersSettingsPage.js";
import type { MembersSettingsData } from "./members.types.js";

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

afterEach(() => {
  cleanup();
});

const teamData: MembersSettingsData = {
  workspace: {
    id: "ws-team",
    name: "Acme Team",
    plan: "team",
    planSeats: 8,
  },
  members: [
    {
      id: "m1",
      userId: "u-owner",
      role: "OWNER",
      joinedAt: "2026-01-01T00:00:00.000Z",
      name: "Alex Kerr",
      email: "alex@example.com",
    },
    {
      id: "m2",
      userId: "u-admin",
      role: "ADMIN",
      joinedAt: "2026-02-01T00:00:00.000Z",
      name: "Sarah K.",
      email: "sarah@example.com",
    },
  ],
  pendingInvitations: [
    {
      id: "inv-1",
      invitedEmail: "pending@example.com",
      role: "MEMBER",
      invitedByName: "Alex Kerr",
      expiresAt: "2026-06-15T00:00:00.000Z",
    },
  ],
  teams: [
    {
      id: "team-1",
      name: "Frontend",
      description: "Web engineers",
      memberCount: 1,
      memberIds: ["u-owner"],
    },
  ],
  currentUserId: "u-owner",
  currentUserRole: "OWNER",
};

describe("MembersSettingsPage", () => {
  it("shows plan gate for non-Team workspaces", () => {
    const view = render(
      <ToastProvider dismissLabel="Dismiss notification">
        <MembersSettingsPage
          initialData={{
            ...teamData,
            workspace: { ...teamData.workspace, plan: "personal" },
          }}
        />
      </ToastProvider>,
    );
    expect(view.getByTestId("members-plan-gate")).toBeTruthy();
  });

  it("renders members tab content for Team workspaces", () => {
    const view = render(
      <ToastProvider dismissLabel="Dismiss notification">
        <MembersSettingsPage initialData={teamData} />
      </ToastProvider>,
    );
    expect(view.getByTestId("members-settings-page")).toBeTruthy();
    expect(view.getByText("Alex Kerr")).toBeTruthy();
    expect(view.getByText("pending@example.com")).toBeTruthy();
  });

  it("shows owner role controls for the current owner", () => {
    const view = render(
      <ToastProvider dismissLabel="Dismiss notification">
        <MembersSettingsPage initialData={teamData} />
      </ToastProvider>,
    );
    expect(view.getAllByText("Transfer ownership…").length).toBeGreaterThan(0);
  });
});

describe("MembersPlanGate", () => {
  it("renders upgrade messaging", () => {
    const view = render(<MembersPlanGate />);
    expect(view.getByTestId("members-plan-gate")).toBeTruthy();
    expect(view.getByRole("button", { name: "Upgrade to Team" })).toBeTruthy();
  });
});
