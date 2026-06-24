import { ToastProvider } from "@slugbase/ui";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { staticMessages } from "../../../i18n/messages.js";
import { MembersPlanGate } from "./components/MembersPlanGate.js";
import { MembersSettingsPage } from "./components/MembersSettingsPage.js";
import type { MembersSettingsData } from "./members.types.js";

const { createInvitation, getInvitationLink } = vi.hoisted(() => ({
  createInvitation: vi.fn(),
  getInvitationLink: vi.fn(),
}));

vi.mock("./members-api.js", () => ({
  addTeamMember: vi.fn(),
  createInvitation,
  createTeam: vi.fn(),
  deleteTeam: vi.fn(),
  getInvitationLink,
  removeMember: vi.fn(),
  removeTeamMember: vi.fn(),
  resendInvitation: vi.fn(),
  revokeInvitation: vi.fn(),
  transferOwnership: vi.fn(),
  updateMemberRole: vi.fn(),
}));

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
  vi.clearAllMocks();
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
  membersForbidden: false,
  mailTransportAvailable: true,
};

function renderMembersPage(data: MembersSettingsData = teamData) {
  return render(
    <ToastProvider dismissLabel="Dismiss notification">
      <MembersSettingsPage initialData={data} />
    </ToastProvider>,
  );
}

describe("MembersSettingsPage", () => {
  const writeText = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    writeText.mockClear();
  });

  it("shows plan gate for non-Team workspaces", () => {
    const view = renderMembersPage({
      ...teamData,
      workspace: { ...teamData.workspace, plan: "personal" },
    });
    expect(view.getByTestId("members-plan-gate")).toBeTruthy();
  });

  it("renders members tab content for Team workspaces", () => {
    const view = renderMembersPage();
    expect(view.getByTestId("members-settings-page")).toBeTruthy();
    expect(view.getByText("Alex Kerr")).toBeTruthy();
    expect(view.getByText("pending@example.com")).toBeTruthy();
  });

  it("shows owner role controls for the current owner", () => {
    const view = renderMembersPage();
    expect(view.getAllByText("Transfer ownership…").length).toBeGreaterThan(0);
  });

  it("shows invite delivery choice in the invite form", () => {
    const view = renderMembersPage();
    fireEvent.click(view.getByRole("button", { name: "Invite member" }));
    expect(view.getByText("Delivery")).toBeTruthy();
    expect(view.getByLabelText("Send email")).toBeTruthy();
    expect(view.getByLabelText("Copy link")).toBeTruthy();
    expect(view.getByTestId("invite-submit-action").textContent).toBe("Send invite");
    fireEvent.click(view.getByLabelText("Copy link"));
    expect(view.getByTestId("invite-submit-action").textContent).toBe("Create invite link");
  });

  it("shows ShownOncePanel after creating an invite link", async () => {
    createInvitation.mockResolvedValue({
      id: "inv-2",
      invitedEmail: "link@example.com",
      role: "MEMBER",
      invitedByName: "",
      expiresAt: "2026-07-01T00:00:00.000Z",
      acceptUrl: "https://app.slugbase.test/invitations/token-abc",
    });

    const view = renderMembersPage();
    fireEvent.click(view.getByRole("button", { name: "Invite member" }));
    fireEvent.change(view.getByLabelText("Email address"), {
      target: { value: "link@example.com" },
    });
    fireEvent.click(view.getByLabelText("Copy link"));
    fireEvent.click(view.getByTestId("invite-submit-action"));

    await waitFor(() => {
      expect(createInvitation).toHaveBeenCalledWith(
        "ws-team",
        "link@example.com",
        "MEMBER",
        "link",
      );
    });
    expect(view.getByTestId("invite-link-shown-once-panel")).toBeTruthy();
    expect(view.getByText("https://app.slugbase.test/invitations/token-abc")).toBeTruthy();
  });

  it("copies a fresh invitation link from the pending list", async () => {
    getInvitationLink.mockResolvedValue("https://app.slugbase.test/invitations/token-rotated");

    const view = renderMembersPage();
    fireEvent.click(view.getByTestId("pending-copy-link-inv-1"));

    await waitFor(() => {
      expect(getInvitationLink).toHaveBeenCalledWith("inv-1");
    });
    expect(writeText).toHaveBeenCalledWith(
      "https://app.slugbase.test/invitations/token-rotated",
    );
  });

  it("shows resend on pending invitations when mail transport is available", () => {
    const view = renderMembersPage();
    expect(view.getByTestId("pending-resend-inv-1")).toBeTruthy();
  });

  it("shows admin role gate for MEMBER users", () => {
    const view = renderMembersPage({
      ...teamData,
      currentUserRole: "MEMBER",
      membersForbidden: true,
      members: [],
      pendingInvitations: [],
    });
    expect(view.getByTestId("workspace-admin-role-gate")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Invite member" })).toBeNull();
  });
});

describe("MembersSettingsPage — mail transport unavailable", () => {
  const mailUnavailableData: MembersSettingsData = {
    ...teamData,
    mailTransportAvailable: false,
  };

  it("hides delivery choice and shows info banner in invite form", () => {
    const view = renderMembersPage(mailUnavailableData);
    fireEvent.click(view.getByRole("button", { name: "Invite member" }));
    expect(view.getByTestId("members-mail-unavailable-banner")).toBeTruthy();
    expect(view.queryByText("Delivery")).toBeNull();
    expect(view.queryByLabelText("Send email")).toBeNull();
    expect(view.getByTestId("invite-submit-action").textContent).toBe("Create invite link");
  });

  it("forces link delivery and shows ShownOncePanel after invite", async () => {
    createInvitation.mockResolvedValue({
      id: "inv-3",
      invitedEmail: "manual@example.com",
      role: "MEMBER",
      invitedByName: "",
      expiresAt: "2026-07-01T00:00:00.000Z",
      acceptUrl: "https://app.slugbase.test/invitations/token-manual",
    });

    const view = renderMembersPage(mailUnavailableData);
    fireEvent.click(view.getByRole("button", { name: "Invite member" }));
    fireEvent.change(view.getByLabelText("Email address"), {
      target: { value: "manual@example.com" },
    });
    fireEvent.click(view.getByTestId("invite-submit-action"));

    await waitFor(() => {
      expect(createInvitation).toHaveBeenCalledWith(
        "ws-team",
        "manual@example.com",
        "MEMBER",
        "link",
      );
    });
    expect(view.getByTestId("invite-link-shown-once-panel")).toBeTruthy();
    expect(view.getByText("https://app.slugbase.test/invitations/token-manual")).toBeTruthy();
  });

  it("hides resend on pending invitations when mail transport is unavailable", () => {
    const view = renderMembersPage(mailUnavailableData);
    expect(view.queryByTestId("pending-resend-inv-1")).toBeNull();
    expect(view.getByTestId("pending-copy-link-inv-1")).toBeTruthy();
  });
});

describe("MembersPlanGate", () => {
  it("renders upgrade messaging", () => {
    const view = render(<MembersPlanGate />);
    expect(view.getByTestId("members-plan-gate")).toBeTruthy();
    expect(view.getByRole("button", { name: "Upgrade to Team" })).toBeTruthy();
  });
});
