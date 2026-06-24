import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { staticMessages } from "../../../i18n/messages.js";
import { AuditSettingsPage } from "./components/AuditSettingsPage.js";
import type { AuditLoaderData } from "./audit.types.js";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const messages = staticMessages.en as Record<string, string>;
      return messages[key] ?? key;
    },
  }),
}));

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    useSearchParams: () => [new URLSearchParams(), vi.fn()] as const,
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

const ownerData: AuditLoaderData = {
  currentUserRole: "OWNER",
  workspace: { id: "ws-1", plan: "team" },
  events: {
    items: [],
    total: 0,
    page: 0,
    pageSize: 8,
    actors: [],
  },
  roleDenied: false,
  planDenied: false,
  loadError: false,
};

function renderAuditPage(data: AuditLoaderData = ownerData) {
  return render(<AuditSettingsPage data={data} />);
}

describe("AuditSettingsPage", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_BILLING_ENABLED", "false");
  });

  it("shows admin role gate for MEMBER users when billing is disabled", () => {
    const view = renderAuditPage({
      ...ownerData,
      currentUserRole: "MEMBER",
      roleDenied: true,
      events: null,
    });
    expect(view.getByTestId("workspace-admin-role-gate")).toBeTruthy();
    expect(view.queryByTestId("audit-plan-gate")).toBeNull();
  });

  it("shows admin role gate for MEMBER users when billing is enabled", () => {
    vi.stubEnv("VITE_BILLING_ENABLED", "true");
    const view = renderAuditPage({
      ...ownerData,
      currentUserRole: "MEMBER",
      roleDenied: true,
      events: null,
    });
    expect(view.getByTestId("workspace-admin-role-gate")).toBeTruthy();
    expect(view.queryByTestId("audit-plan-gate")).toBeNull();
  });

  it("shows plan gate for OWNER on non-team plan when billing is enabled", () => {
    vi.stubEnv("VITE_BILLING_ENABLED", "true");
    const view = renderAuditPage({
      ...ownerData,
      workspace: { id: "ws-1", plan: "free" },
      planDenied: true,
      events: null,
    });
    expect(view.getByTestId("audit-plan-gate")).toBeTruthy();
    expect(view.queryByTestId("workspace-admin-role-gate")).toBeNull();
  });

  it("does not show plan gate for OWNER on free plan when billing is disabled", () => {
    const view = renderAuditPage({
      ...ownerData,
      workspace: { id: "ws-1", plan: "free" },
      planDenied: true,
      events: null,
    });
    expect(view.queryByTestId("audit-plan-gate")).toBeNull();
    expect(view.getByTestId("audit-load-error")).toBeTruthy();
  });

  it("shows load error instead of plan gate when events fail on CE", () => {
    const view = renderAuditPage({
      ...ownerData,
      events: null,
      loadError: true,
    });
    expect(view.getByTestId("audit-load-error")).toBeTruthy();
    expect(view.queryByTestId("audit-plan-gate")).toBeNull();
  });

  it("renders audit log page when data loads successfully", () => {
    const view = renderAuditPage();
    expect(view.getByTestId("audit-log-page")).toBeTruthy();
  });
});
