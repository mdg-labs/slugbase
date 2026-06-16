import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider, ToastProvider } from "@slugbase/ui";

import { staticMessages } from "../../../i18n/messages.js";
import * as accountApi from "./account-api.js";
import { AccountSettingsPage } from "./components/AccountSettingsPage.js";
import { PreferencesSection } from "./components/PreferencesSection.js";
import type { AccountSettingsData } from "./account.types.js";

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
  vi.restoreAllMocks();
});

const baseAccount: AccountSettingsData = {
  id: "user-1",
  email: "alex@example.com",
  name: "Alex Kerr",
  emailVerified: true,
  pendingEmail: null,
  pendingEmailMasked: null,
  mfaState: "not_enrolled",
  remainingBackupCodes: null,
  hasPassword: true,
  language: "en",
  theme: "dark",
  accentColor: null,
  aiOptOut: false,
  defaultBookmarkView: "grid",
  onboardingCompletedAt: null,
  dashboardChecklistDismissed: false,
  dashboardChecklistManual: {
    import: false,
    browser_shortcut: false,
    folder: false,
    tag: false,
  },
};

function renderPage(account: AccountSettingsData = baseAccount) {
  return render(
    <ThemeProvider>
      <ToastProvider dismissLabel="Dismiss notification">
        <AccountSettingsPage initialAccount={account} initialTokens={[]} />
      </ToastProvider>
    </ThemeProvider>,
  );
}

describe("AccountSettingsPage", () => {
  beforeEach(() => {
    vi.spyOn(accountApi, "startMfaEnrol").mockRejectedValue(new Error("not used"));
    vi.spyOn(accountApi, "confirmMfaEnrol").mockRejectedValue(new Error("not used"));
    vi.spyOn(accountApi, "disableMfa").mockRejectedValue(new Error("not used"));
    vi.spyOn(accountApi, "regenerateMfaBackupCodes").mockRejectedValue(new Error("not used"));
    vi.spyOn(accountApi, "createApiToken").mockRejectedValue(new Error("not used"));
    vi.spyOn(accountApi, "revokeApiToken").mockRejectedValue(new Error("not used"));
  });

  it("renders account settings with profile section", () => {
    const view = renderPage();
    expect(view.getByTestId("account-settings-page")).toBeTruthy();
    expect(view.getByLabelText("Display name")).toBeTruthy();
    expect(view.getByDisplayValue("Alex Kerr")).toBeTruthy();
  });

  it("persists profile changes", async () => {
    vi.spyOn(accountApi, "updateAccountProfile").mockResolvedValue({
      ...baseAccount,
      name: "Alexandra Kerr",
    });

    const view = renderPage();
    fireEvent.change(view.getByLabelText("Display name"), {
      target: { value: "Alexandra Kerr" },
    });
    fireEvent.click(view.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(accountApi.updateAccountProfile).toHaveBeenCalledWith({ name: "Alexandra Kerr" });
    });
    expect(view.getByText("Profile saved")).toBeTruthy();
  });

  it("persists preference changes", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const view = render(
      <ThemeProvider>
        <PreferencesSection
          account={baseAccount}
          t={(key: string) => (staticMessages.en as Record<string, string>)[key] ?? key}
          onSave={onSave}
        />
      </ThemeProvider>,
    );

    fireEvent.change(view.getByLabelText("Language"), {
      target: { value: "de" },
    });
    fireEvent.click(view.getByRole("checkbox"));
    fireEvent.click(view.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith({
        language: "de",
        theme: "dark",
        accentColor: null,
        aiOptOut: true,
        defaultBookmarkView: "grid",
      });
    });
  });
});
