import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider, ToastProvider } from "@slugbase/ui";

import { staticMessages } from "../../../i18n/messages.js";
import { AiSection } from "./components/AiSection.js";
import { WorkspaceSettingsPage } from "./components/WorkspaceSettingsPage.js";
import type { WorkspaceInterfaceConfig, WorkspaceSettingsData } from "./workspace.types.js";

const mockSearchParams = vi.fn(() => [new URLSearchParams(), vi.fn()]);

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    useSearchParams: () => mockSearchParams(),
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
  mockSearchParams.mockReset();
  mockSearchParams.mockReturnValue([new URLSearchParams(), vi.fn()]);
});

const ceOperatorConfig: WorkspaceInterfaceConfig = {
  aiByoCredential: false,
  billingEnabled: false,
};

const baseData: WorkspaceSettingsData = {
  workspace: { id: "ws-1", name: "Acme Engineering", plan: "team" },
  currentUserRole: "OWNER",
  membersForbidden: false,
  interfaceConfig: ceOperatorConfig,
  ai: { enabled: true, hasApiKey: true, model: "gpt-4o-mini" },
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

  it("falls back to general when section is smtp", () => {
    mockSearchParams.mockReturnValue([new URLSearchParams("section=smtp"), vi.fn()]);
    const view = renderPage();
    expect(view.getByLabelText("Workspace name")).toBeTruthy();
    expect(view.queryByTestId("workspace-operator-managed-gate")).toBeNull();
  });

  it("falls back to general when section is oidc", () => {
    mockSearchParams.mockReturnValue([new URLSearchParams("section=oidc"), vi.fn()]);
    const view = renderPage();
    expect(view.getByLabelText("Workspace name")).toBeTruthy();
    expect(view.queryByTestId("workspace-operator-managed-gate")).toBeNull();
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
  const selfHostByoConfig: WorkspaceInterfaceConfig = {
    aiByoCredential: true,
    billingEnabled: false,
  };

  const operatorManagedConfig: WorkspaceInterfaceConfig = {
    aiByoCredential: false,
    billingEnabled: false,
  };

  it("shows BYO credential fields without enabling AI when BYO is enabled", () => {
    const view = renderAiSection({ interfaceConfig: selfHostByoConfig });
    expect(view.getByLabelText("API key")).toBeTruthy();
    expect(view.getByLabelText("Model")).toBeTruthy();
    const checkbox = view.getByRole("checkbox");
    expect((checkbox as HTMLInputElement).checked).toBe(false);
  });

  it("shows BYO fields when BYO is enabled and AI is on", () => {
    const view = renderAiSection({ enabled: true, hasApiKey: true, interfaceConfig: selfHostByoConfig });
    expect(view.getByLabelText("API key")).toBeTruthy();
    expect(view.getByLabelText("Model")).toBeTruthy();
    expect((view.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
  });

  it("shows enable toggle only on CE operator-managed AI", () => {
    const view = renderAiSection({ enabled: true, interfaceConfig: operatorManagedConfig });
    expect(view.queryByLabelText("API key")).toBeNull();
    expect(view.queryByLabelText("Model")).toBeNull();
    expect((view.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
  });

  it("hides BYO fields and operator notice when AI is disabled on operator-managed", () => {
    const view = renderAiSection({ interfaceConfig: operatorManagedConfig });
    expect(view.queryByLabelText("API key")).toBeNull();
    expect(view.queryByText(/credential configured by the operator/)).toBeNull();
  });
});
