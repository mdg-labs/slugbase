import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider, ToastProvider } from "@slugbase/ui";

import { staticMessages } from "../../../i18n/messages.js";
import { WorkspaceSettingsPage } from "./components/WorkspaceSettingsPage.js";
import type { WorkspaceSettingsData } from "./workspace.types.js";

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    useSearchParams: () => [new URLSearchParams(), vi.fn()],
  };
});

vi.mock("@tolgee/react", () => ({
  useTranslate: () => ({
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

const baseData: WorkspaceSettingsData = {
  workspace: { id: "ws-1", name: "Acme Engineering", plan: "team" },
  currentUserRole: "OWNER",
  interfaceConfig: {
    mailAdminUi: true,
    oidcAdminUi: true,
    aiByoCredential: true,
    billingEnabled: false,
  },
  appBaseUrl: "https://api.example.com",
  mail: null,
  ai: { enabled: true, hasApiKey: true, model: "gpt-4o-mini" },
  oidcProviders: [],
};

function renderPage(data: WorkspaceSettingsData = baseData) {
  return render(
    <ThemeProvider>
      <ToastProvider dismissLabel="Dismiss notification">
        <WorkspaceSettingsPage initialData={data} />
      </ToastProvider>
    </ThemeProvider>,
  );
}

describe("WorkspaceSettingsPage", () => {
  it("renders workspace settings with general section", () => {
    const view = renderPage();
    expect(view.getByTestId("workspace-settings-page")).toBeTruthy();
    expect(view.getByLabelText("Workspace name")).toBeTruthy();
    expect(view.getByDisplayValue("Acme Engineering")).toBeTruthy();
  });

  it("shows SMTP and OIDC tabs when admin UI interfaces are enabled", () => {
    const view = renderPage();
    expect(view.getByRole("button", { name: "Email" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Identity" })).toBeTruthy();
  });

  it("hides SMTP and OIDC tabs when operator-managed interfaces are active", () => {
    const view = renderPage({
      ...baseData,
      interfaceConfig: {
        mailAdminUi: false,
        oidcAdminUi: false,
        aiByoCredential: false,
        billingEnabled: true,
      },
    });
    expect(view.queryByRole("button", { name: "Email" })).toBeNull();
    expect(view.queryByRole("button", { name: "Identity" })).toBeNull();
    expect(view.getByRole("button", { name: "AI" })).toBeTruthy();
  });

  it("shows admin-only gate for members", () => {
    const view = renderPage({
      ...baseData,
      currentUserRole: "MEMBER",
    });
    expect(view.getByTestId("workspace-admin-role-gate")).toBeTruthy();
  });
});
