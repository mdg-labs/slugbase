import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { staticMessages } from "../../i18n/messages.js";

vi.mock("react-router", () => ({
  useNavigate: () => vi.fn(),
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

vi.mock("./workspace-switcher-api.js", () => ({
  activateWorkspace: vi.fn(),
  createWorkspace: vi.fn(),
}));

import { WorkspaceSwitcherPanel } from "./WorkspaceSwitcherPanel.js";

const workspaces = [
  { id: "ws-1", name: "Primary", plan: "free" as const, role: "OWNER" as const },
  { id: "ws-2", name: "Secondary", plan: "personal" as const, role: "MEMBER" as const },
];

describe("WorkspaceSwitcherPanel", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
  });

  it("hides plan text in list rows when billing is disabled", () => {
    vi.stubEnv("VITE_BILLING_ENABLED", "false");

    render(
      <WorkspaceSwitcherPanel
        workspaces={workspaces}
        activeWorkspaceId="ws-1"
        onClose={() => undefined}
      />,
    );

    expect(screen.getByText("Primary")).toBeTruthy();
    expect(screen.getByText("Secondary")).toBeTruthy();
    expect(screen.queryByText(/free · owner/i)).toBeNull();
    expect(screen.queryByText(/personal · member/i)).toBeNull();
  });

  it("shows plan text in list rows when billing is enabled", () => {
    vi.stubEnv("VITE_BILLING_ENABLED", "true");

    render(
      <WorkspaceSwitcherPanel
        workspaces={workspaces}
        activeWorkspaceId="ws-1"
        onClose={() => undefined}
      />,
    );

    expect(screen.getByText("free · owner")).toBeTruthy();
    expect(screen.getByText("personal · member")).toBeTruthy();
  });

  it("allows workspace creation on free plan when billing is disabled", () => {
    vi.stubEnv("VITE_BILLING_ENABLED", "false");

    render(
      <WorkspaceSwitcherPanel
        workspaces={workspaces}
        activeWorkspaceId="ws-1"
        onClose={() => undefined}
      />,
    );

    fireEvent.click(screen.getByTestId("workspace-switcher-create-btn"));

    expect(screen.getByLabelText("Workspace name")).toBeTruthy();
    expect(screen.queryByText("Upgrade to create more workspaces")).toBeNull();
  });

  it("blocks workspace creation on free plan when billing is enabled", () => {
    vi.stubEnv("VITE_BILLING_ENABLED", "true");

    render(
      <WorkspaceSwitcherPanel
        workspaces={workspaces}
        activeWorkspaceId="ws-1"
        onClose={() => undefined}
      />,
    );

    fireEvent.click(screen.getByTestId("workspace-switcher-create-btn"));

    expect(screen.getByText("Upgrade to create more workspaces")).toBeTruthy();
    expect(screen.queryByLabelText("Workspace name")).toBeNull();
  });
});
