import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { staticMessages } from "../../../i18n/messages.js";
import { BillingSettingsPage } from "./components/BillingSettingsPage.js";
import { BillingUnavailableGate } from "./components/BillingUnavailableGate.js";
import type { BillingSettingsData } from "./billing.types.js";

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

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    useSearchParams: () => [new URLSearchParams(), vi.fn()],
  };
});

const checkoutMock = vi.fn();
const portalMock = vi.fn();

vi.mock("./billing-api.js", () => ({
  startCheckout: (params: unknown): Promise<{ checkoutUrl: string }> =>
    checkoutMock(params) as Promise<{ checkoutUrl: string }>,
  openBillingPortal: (
    workspaceId: string,
    returnUrl: string,
  ): Promise<{ portalUrl: string }> =>
    portalMock(workspaceId, returnUrl) as Promise<{ portalUrl: string }>,
  updateSeatQuantity: vi.fn(),
  loadBillingSettingsData: vi.fn(),
}));

afterEach(() => {
  cleanup();
  checkoutMock.mockReset();
  portalMock.mockReset();
});

const baseData: BillingSettingsData = {
  workspace: {
    id: "ws-1",
    name: "Acme",
    plan: "free",
    planSeats: null,
    planArchived: false,
    billingCustomerId: null,
    billingSubscriptionId: null,
    billingStatus: null,
    billingPeriodEnd: null,
    permanentPersonal: false,
  },
  bookmarkCount: 23,
  archivedBookmarkCount: 0,
  memberCount: 1,
  currentUserId: "u-owner",
  currentUserRole: "OWNER",
  planConfig: {
    billingEnabled: true,
    personalMonthlyPrice: "$4",
    personalYearlyPrice: "$40",
    teamSeatPrice: "$9",
    supporterPrice: "$59",
    supporterPromotionEnd: "2026-12-31T23:59:59.000Z",
    teamBaseSeats: 5,
    freeBookmarkCap: 50,
  },
  returnUrl: "https://app.example/settings/billing",
};

describe("BillingSettingsPage", () => {
  it("renders plan comparison table from config", () => {
    const view = render(<BillingSettingsPage initialData={baseData} />);
    expect(view.getByTestId("billing-plan-table")).toBeTruthy();
    expect(view.getByText("$4")).toBeTruthy();
    expect(view.getByText("Personal")).toBeTruthy();
    expect(view.queryByText("Pro")).toBeNull();
  });

  it("starts checkout when upgrading to Personal", async () => {
    checkoutMock.mockResolvedValue({ checkoutUrl: "https://checkout.test/session" });
    const assignSpy = vi.spyOn(window.location, "assign").mockImplementation(() => {});

    const view = render(<BillingSettingsPage initialData={baseData} />);
    fireEvent.click(
      view.getByRole("button", { name: "Upgrade to Personal" }),
    );

    await waitFor(() => {
      expect(checkoutMock).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: "ws-1",
          plan: "personal",
          mode: "recurring",
        }),
      );
    });

    assignSpy.mockRestore();
  });

  it("opens billing portal for cancel confirmation", async () => {
    portalMock.mockResolvedValue({ portalUrl: "https://portal.test/session" });
    const assignSpy = vi.spyOn(window.location, "assign").mockImplementation(() => {});

    const view = render(
      <BillingSettingsPage
        initialData={{
          ...baseData,
          workspace: {
            ...baseData.workspace,
            plan: "personal",
            billingCustomerId: "cus_123",
            billingStatus: "active",
            billingPeriodEnd: "2026-07-01T00:00:00.000Z",
          },
        }}
      />,
    );

    fireEvent.click(view.getByRole("button", { name: "Cancel subscription" }));
    fireEvent.click(view.getByRole("button", { name: "Yes, cancel subscription" }));
    fireEvent.click(view.getByRole("button", { name: "Confirm cancellation" }));

    await waitFor(() => {
      expect(portalMock).toHaveBeenCalledWith("ws-1", baseData.returnUrl);
    });

    assignSpy.mockRestore();
  });

  it("shows unavailable gate when billing is disabled", () => {
    const view = render(
      <BillingSettingsPage
        initialData={{
          ...baseData,
          planConfig: { ...baseData.planConfig, billingEnabled: false },
        }}
      />,
    );
    expect(view.getByTestId("billing-unavailable-gate")).toBeTruthy();
  });
});

describe("BillingUnavailableGate", () => {
  it("renders self-hosted messaging", () => {
    const view = render(<BillingUnavailableGate />);
    expect(view.getByTestId("billing-unavailable-gate")).toBeTruthy();
    expect(view.getByText("Billing is not available")).toBeTruthy();
  });
});
