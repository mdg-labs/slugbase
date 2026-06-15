import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider, ToastProvider } from "@slugbase/ui";

import { staticMessages } from "../../../i18n/messages.js";
import { AiSection } from "./components/AiSection.js";
import { WorkspaceSettingsPage } from "./components/WorkspaceSettingsPage.js";
import type { WorkspaceInterfaceConfig, WorkspaceSettingsData } from "./workspace.types.js";

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    useSearchParams: () => [new URLSearchParams(), vi.fn()],
  };
});

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

const baseData: WorkspaceSettingsData = {
  workspace: { id: "ws-1", name: "Acme Engineering", plan: "team" },
  currentUserRole: "OWNER",
  membersForbidden: false,
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

  it("renders workspace settings with all admin UI interfaces enabled (no tab strip)", () => {
    const view = renderPage();
    expect(view.getByTestId("workspace-settings-page")).toBeTruthy();
    expect(view.getByLabelText("Workspace name")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Email" })).toBeNull();
    expect(view.queryByRole("button", { name: "Identity" })).toBeNull();
  });

  it("renders workspace settings without horizontal nav when operator-managed interfaces are active", () => {
    const view = renderPage({
      ...baseData,
      interfaceConfig: {
        mailAdminUi: false,
        oidcAdminUi: false,
        aiByoCredential: false,
        billingEnabled: true,
      },
    });
    expect(view.getByTestId("workspace-settings-page")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Email" })).toBeNull();
    expect(view.queryByRole("button", { name: "Identity" })).toBeNull();
    expect(view.queryByRole("button", { name: "AI" })).toBeNull();
  });

  it("shows admin-only gate for members", () => {
    const view = renderPage({
      ...baseData,
      currentUserRole: "MEMBER",
    });
    expect(view.getByTestId("workspace-admin-role-gate")).toBeTruthy();
  });
});

function renderAiSection(options: {
  enabled?: boolean;
  hasApiKey?: boolean;
  interfaceConfig: WorkspaceInterfaceConfig;
}) {
  const t = (key: string) => (staticMessages.en as Record<string, string>)[key] ?? key;
  return render(
    <ThemeProvider>
      <AiSection
        initial={{
          enabled: options.enabled ?? false,
          hasApiKey: options.hasApiKey ?? false,
          model: "gpt-4o-mini",
        }}
        interfaceConfig={options.interfaceConfig}
        onSave={vi.fn().mockResolvedValue(undefined)}
        t={t}
      />
    </ThemeProvider>,
  );
}

describe("AiSection", () => {
  const selfHostConfig: WorkspaceInterfaceConfig = {
    mailAdminUi: true,
    oidcAdminUi: true,
    aiByoCredential: true,
    billingEnabled: false,
  };

  const hostedConfig: WorkspaceInterfaceConfig = {
    mailAdminUi: false,
    oidcAdminUi: false,
    aiByoCredential: false,
    billingEnabled: true,
  };

  it("shows BYO credential fields without enabling AI on self-host", () => {
    const view = renderAiSection({ interfaceConfig: selfHostConfig });
    expect(view.getByLabelText("API key")).toBeTruthy();
    expect(view.getByLabelText("Model")).toBeTruthy();
    const checkbox = view.getByRole("checkbox");
    expect((checkbox as HTMLInputElement).checked).toBe(false);
  });

  it("shows BYO fields on self-host when AI is enabled", () => {
    const view = renderAiSection({ enabled: true, hasApiKey: true, interfaceConfig: selfHostConfig });
    expect(view.getByLabelText("API key")).toBeTruthy();
    expect(view.getByLabelText("Model")).toBeTruthy();
    expect((view.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
  });

  it("hides BYO fields on hosted and shows operator notice when enabled", () => {
    const view = renderAiSection({ enabled: true, interfaceConfig: hostedConfig });
    expect(view.queryByLabelText("API key")).toBeNull();
    expect(view.getByText(/credential configured by the operator/)).toBeTruthy();
  });

  it("hides BYO fields and operator notice on hosted when disabled", () => {
    const view = renderAiSection({ interfaceConfig: hostedConfig });
    expect(view.queryByLabelText("API key")).toBeNull();
    expect(view.queryByText(/credential configured by the operator/)).toBeNull();
  });
});
