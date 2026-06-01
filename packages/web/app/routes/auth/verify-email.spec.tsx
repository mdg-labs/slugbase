import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-router", async (importOriginal) => {
  const original = await importOriginal<typeof import("react-router")>();
  return {
    ...original,
    Form: ({
      children,
      ...props
    }: React.FormHTMLAttributes<HTMLFormElement> & { children: React.ReactNode }) => (
      <form {...props}>{children}</form>
    ),
    Link: ({
      children,
      to,
      ...props
    }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
      <a href={to} {...props}>
        {children}
      </a>
    ),
    redirect: vi.fn((url: string) => new Response(null, { status: 302, headers: { Location: url } })),
    useActionData: vi.fn(() => undefined),
    useLoaderData: vi.fn(() => ({ mode: "pending", email: "user@example.com" })),
    useNavigation: vi.fn(() => ({ state: "idle", formData: undefined })),
  };
});

vi.mock("@tolgee/react", () => ({
  useTranslate: () => ({
    t: (key: string, params?: Record<string, string>) =>
      params?.email ? `${key}:${params.email}` : key,
  }),
}));

const mockShowToast = vi.fn();
const mockShowError = vi.fn();

vi.mock("../../components/feedback/AppToastProvider.js", () => ({
  useAppToast: () => ({
    showToast: mockShowToast,
    showError: mockShowError,
  }),
}));

vi.mock("../../lib/session-client.js", () => ({
  getSessionUser: vi.fn(),
}));

import { useActionData, useLoaderData, useNavigation } from "react-router";
import { action, loader } from "./verify-email.js";

const mockUseActionData = vi.mocked(useActionData);
const mockUseLoaderData = vi.mocked(useLoaderData);
const mockUseNavigation = vi.mocked(useNavigation);

describe("Verify-email route — loader", () => {
  beforeEach(() => {
    process.env["API_BASE_URL"] = "http://localhost:3000";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env["API_BASE_URL"];
  });

  it("redirects unauthenticated users to login", async () => {
    const { getSessionUser } = await import("../../lib/session-client.js");
    vi.mocked(getSessionUser).mockResolvedValueOnce(null);

    const request = new Request("http://localhost/verify-email");
    const args = { request, params: {}, context: {} } as unknown as LoaderFunctionArgs;
    const result = await loader(args);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).headers.get("Location")).toBe("/login");
  });

  it("redirects verified users to home", async () => {
    const { getSessionUser } = await import("../../lib/session-client.js");
    vi.mocked(getSessionUser).mockResolvedValueOnce({
      id: "user-1",
      email: "alice@example.com",
      name: "Alice",
      language: "en",
      mfaState: "not_enrolled",
      emailVerified: true,
    });

    const request = new Request("http://localhost/verify-email");
    const args = { request, params: {}, context: {} } as unknown as LoaderFunctionArgs;
    const result = await loader(args);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).headers.get("Location")).toBe("/");
  });

  it("returns pending data for unverified session", async () => {
    const { getSessionUser } = await import("../../lib/session-client.js");
    vi.mocked(getSessionUser).mockResolvedValueOnce({
      id: "user-1",
      email: "pending@example.com",
      name: "Pending",
      language: "en",
      mfaState: "not_enrolled",
      emailVerified: false,
    });

    const request = new Request("http://localhost/verify-email");
    const args = { request, params: {}, context: {} } as unknown as LoaderFunctionArgs;
    const result = await loader(args);
    expect(result).toEqual({ mode: "pending", email: "pending@example.com" });
  });

  it("returns complete success when token verification succeeds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true, userId: "user-1" }), { status: 200 }),
      ),
    );

    const request = new Request("http://localhost/verify-email?token=abc123");
    const args = { request, params: {}, context: {} } as unknown as LoaderFunctionArgs;
    const result = await loader(args);
    expect(result).toEqual({ mode: "complete", success: true });
  });
});

describe("Verify-email route — action", () => {
  beforeEach(() => {
    process.env["API_BASE_URL"] = "http://localhost:3000";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env["API_BASE_URL"];
  });

  it("returns resend success on 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      ),
    );

    const formData = new FormData();
    formData.set("_intent", "resend");

    const request = new Request("http://localhost/verify-email", {
      method: "POST",
      body: formData,
    });
    const args = { request, params: {}, context: {} } as unknown as ActionFunctionArgs;
    const result = await action(args);
    expect(result).toEqual({ intent: "resend", ok: true });
  });

  it("returns rate-limit error on resend 429", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: "Too many" }), { status: 429 }),
      ),
    );

    const formData = new FormData();
    formData.set("_intent", "resend");

    const request = new Request("http://localhost/verify-email", {
      method: "POST",
      body: formData,
    });
    const args = { request, params: {}, context: {} } as unknown as ActionFunctionArgs;
    const result = await action(args);
    expect(result).toEqual({
      intent: "resend",
      ok: false,
      error: "auth.verify_email.toast_resend_rate_limit",
    });
  });

  it("returns masked email on successful correction", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ maskedEmail: "f***@e***.com" }), { status: 200 }),
      ),
    );

    const formData = new FormData();
    formData.set("_intent", "correct");
    formData.set("email", "fixed@example.com");

    const request = new Request("http://localhost/verify-email", {
      method: "POST",
      body: formData,
    });
    const args = { request, params: {}, context: {} } as unknown as ActionFunctionArgs;
    const result = await action(args);
    expect(result).toEqual({
      intent: "correct",
      ok: true,
      maskedEmail: "f***@e***.com",
    });
  });

  it("returns taken error on correct 409", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: "Conflict" }), { status: 409 }),
      ),
    );

    const formData = new FormData();
    formData.set("_intent", "correct");
    formData.set("email", "taken@example.com");

    const request = new Request("http://localhost/verify-email", {
      method: "POST",
      body: formData,
    });
    const args = { request, params: {}, context: {} } as unknown as ActionFunctionArgs;
    const result = await action(args);
    expect(result).toEqual({
      intent: "correct",
      ok: false,
      error: "auth.verify_email.change_email_error_taken",
    });
  });
});

describe("Verify-email route — component", () => {
  afterEach(() => {
    cleanup();
    mockShowToast.mockClear();
    mockShowError.mockClear();
  });

  it("renders pending screen with email and action buttons", async () => {
    const VerifyEmailRoute = (await import("./verify-email.js")).default;
    mockUseLoaderData.mockReturnValue({ mode: "pending", email: "user@example.com" });
    mockUseActionData.mockReturnValue(undefined);
    mockUseNavigation.mockReturnValue({ state: "idle", formData: undefined } as ReturnType<
      typeof useNavigation
    >);

    render(<VerifyEmailRoute />);

    expect(screen.getByText("auth.verify_email.title")).toBeTruthy();
    expect(screen.getByText("user@example.com")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "auth.verify_email.resend_button" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "auth.verify_email.change_email_submit" }),
    ).toBeTruthy();
  });

  it("shows success toast after resend action", async () => {
    const VerifyEmailRoute = (await import("./verify-email.js")).default;
    mockUseLoaderData.mockReturnValue({ mode: "pending", email: "user@example.com" });
    mockUseActionData.mockReturnValue({ intent: "resend", ok: true });
    mockUseNavigation.mockReturnValue({ state: "idle", formData: undefined } as ReturnType<
      typeof useNavigation
    >);

    render(<VerifyEmailRoute />);

    await waitFor(() => {
      expect(mockShowToast).toHaveBeenCalledWith("auth.verify_email.toast_resend_success");
    });
  });

  it("updates displayed email after successful correction", async () => {
    const VerifyEmailRoute = (await import("./verify-email.js")).default;
    mockUseLoaderData.mockReturnValue({ mode: "pending", email: "user@example.com" });
    mockUseActionData.mockReturnValue({
      intent: "correct",
      ok: true,
      maskedEmail: "f***@e***.com",
    });
    mockUseNavigation.mockReturnValue({ state: "idle", formData: undefined } as ReturnType<
      typeof useNavigation
    >);

    render(<VerifyEmailRoute />);

    await waitFor(() => {
      expect(screen.getByText("f***@e***.com")).toBeTruthy();
      expect(mockShowToast).toHaveBeenCalledWith("auth.verify_email.toast_change_email_success");
    });
  });
});
