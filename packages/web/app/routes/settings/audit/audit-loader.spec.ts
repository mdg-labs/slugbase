import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { auditSettingsLoader } from "./audit-loader.js";

const { getSessionUser, loadAuditSettingsContext, loadAuditEvents } = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  loadAuditSettingsContext: vi.fn(),
  loadAuditEvents: vi.fn(),
}));

vi.mock("../../../lib/session-client.js", () => ({
  getSessionUser: getSessionUser,
}));

vi.mock("./audit-api.js", () => ({
  loadAuditSettingsContext,
  loadAuditEvents,
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("auditSettingsLoader", () => {
  const request = new Request("http://localhost/settings/audit");
  const loaderArgs = {
    request,
    params: {},
    context: {},
    url: new URL("http://localhost/settings/audit"),
    pattern: "/settings/audit",
  };

  beforeEach(() => {
    getSessionUser.mockResolvedValue({ id: "user-1" });
    vi.stubEnv("VITE_BILLING_ENABLED", "false");
  });

  it("returns role denial for MEMBER without calling audit events API", async () => {
    loadAuditSettingsContext.mockResolvedValue({
      workspace: { id: "ws-2", plan: "free" },
      currentUserRole: "MEMBER",
    });

    const data = await auditSettingsLoader(loaderArgs);

    expect(data).toMatchObject({
      roleDenied: true,
      planDenied: false,
      loadError: false,
      events: null,
    });
    expect(loadAuditEvents).not.toHaveBeenCalled();
  });

  it("returns plan denial for OWNER on free plan when billing is enabled", async () => {
    vi.stubEnv("VITE_BILLING_ENABLED", "true");
    loadAuditSettingsContext.mockResolvedValue({
      workspace: { id: "ws-1", plan: "free" },
      currentUserRole: "OWNER",
    });

    const data = await auditSettingsLoader(loaderArgs);

    expect(data).toMatchObject({
      roleDenied: false,
      planDenied: true,
      loadError: false,
      events: null,
    });
    expect(loadAuditEvents).not.toHaveBeenCalled();
  });

  it("loads events for OWNER on free plan when billing is disabled", async () => {
    loadAuditSettingsContext.mockResolvedValue({
      workspace: { id: "ws-1", plan: "free" },
      currentUserRole: "OWNER",
    });
    loadAuditEvents.mockResolvedValue({
      ok: true,
      data: { items: [], total: 0, page: 0, pageSize: 8, actors: [] },
    });

    const data = await auditSettingsLoader(loaderArgs);

    expect(data).toMatchObject({
      roleDenied: false,
      planDenied: false,
      loadError: false,
    });
    expect(loadAuditEvents).toHaveBeenCalled();
    expect(data.events).not.toBeNull();
  });

  it("returns load error when audit events API fails", async () => {
    loadAuditSettingsContext.mockResolvedValue({
      workspace: { id: "ws-1", plan: "team" },
      currentUserRole: "OWNER",
    });
    loadAuditEvents.mockResolvedValue({ ok: false, status: 500 });

    const data = await auditSettingsLoader(loaderArgs);

    expect(data).toMatchObject({
      roleDenied: false,
      planDenied: false,
      loadError: true,
      events: null,
    });
  });

  it("returns load error when workspace fetch fails", async () => {
    loadAuditSettingsContext.mockResolvedValue({
      workspace: null,
      currentUserRole: "MEMBER",
    });

    const data = await auditSettingsLoader(loaderArgs);

    expect(data).toMatchObject({
      workspace: null,
      roleDenied: false,
      planDenied: false,
      loadError: true,
    });
    expect(loadAuditEvents).not.toHaveBeenCalled();
  });
});
