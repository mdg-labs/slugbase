import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { staticMessages } from "../i18n/messages.js";

vi.mock("react-router", () => ({
  NavLink: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
  useLocation: () => ({ pathname: "/", search: "" }),
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

vi.mock("./LegalLinks.js", () => ({
  LegalLinks: () => null,
}));

import { AppSidebar } from "./AppSidebar.js";

const baseProps = {
  workspace: { id: "ws-1", name: "My Workspace", plan: "free" as const },
  workspaces: [
    { id: "ws-1", name: "My Workspace", plan: "free" as const, role: "OWNER" as const },
  ],
  currentUserRole: "OWNER" as const,
  folders: [],
  bookmarkTotal: 3,
};

describe("AppSidebar", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
  });

  it("hides plan subtitle when billing is disabled", () => {
    vi.stubEnv("VITE_BILLING_ENABLED", "false");

    render(<AppSidebar {...baseProps} />);

    expect(screen.getByText("My Workspace")).toBeTruthy();
    expect(screen.queryByText(/free plan/i)).toBeNull();
  });

  it("shows plan subtitle when billing is enabled", () => {
    vi.stubEnv("VITE_BILLING_ENABLED", "true");

    render(<AppSidebar {...baseProps} />);

    expect(screen.getByText("free plan")).toBeTruthy();
  });

  it("hides Members nav link for MEMBER role", () => {
    render(
      <AppSidebar
        {...baseProps}
        currentUserRole="MEMBER"
        workspaces={[
          { id: "ws-1", name: "My Workspace", plan: "free", role: "MEMBER" },
        ]}
      />,
    );

    expect(screen.queryByText("Members")).toBeNull();
    expect(screen.getByText("Settings")).toBeTruthy();
  });

  it("shows Members nav link for ADMIN role", () => {
    render(
      <AppSidebar
        {...baseProps}
        currentUserRole="ADMIN"
        workspaces={[
          { id: "ws-1", name: "My Workspace", plan: "team", role: "ADMIN" },
        ]}
      />,
    );

    expect(screen.getByText("Members")).toBeTruthy();
  });
});
