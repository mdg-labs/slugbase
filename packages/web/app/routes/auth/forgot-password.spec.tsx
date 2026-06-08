import { cleanup, render, screen } from "@testing-library/react";
import type { ActionFunctionArgs } from "react-router";
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
      to,
      children,
      ...props
    }: { to: string; children: React.ReactNode } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
      <a href={to} {...props}>{children}</a>
    ),
    redirect: vi.fn((url: string) => new Response(null, { status: 302, headers: { Location: url } })),
    useActionData: vi.fn(() => undefined),
    useNavigation: vi.fn(() => ({ state: "idle" })),
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

import { useActionData, useNavigation } from "react-router";
import { action } from "./forgot-password.js";

const mockUseActionData = vi.mocked(useActionData);
const mockUseNavigation = vi.mocked(useNavigation);

describe("ForgotPassword route — action", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    process.env["API_BASE_URL"] = "http://localhost:3000";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env["API_BASE_URL"];
  });

  it("always returns sent=true for a valid email (non-enumerating)", async () => {
    const formData = new FormData();
    formData.set("email", "alice@example.com");
    const request = new Request("http://localhost/forgot-password", {
      method: "POST",
      body: formData,
    });
    const args = { request, params: {}, context: {} } as unknown as ActionFunctionArgs;
    const result = await action(args);
    expect(result).toEqual({ sent: true, email: "alice@example.com" });
  });

  it("returns sent=true even when the backend returns an error (non-enumerating)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: "Not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const formData = new FormData();
    formData.set("email", "unknown@example.com");
    const request = new Request("http://localhost/forgot-password", {
      method: "POST",
      body: formData,
    });
    const args = { request, params: {}, context: {} } as unknown as ActionFunctionArgs;
    const result = await action(args);
    expect(result).toEqual({ sent: true, email: "unknown@example.com" });
  });

  it("returns sent=true even when the network throws (non-enumerating)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));

    const formData = new FormData();
    formData.set("email", "alice@example.com");
    const request = new Request("http://localhost/forgot-password", {
      method: "POST",
      body: formData,
    });
    const args = { request, params: {}, context: {} } as unknown as ActionFunctionArgs;
    const result = await action(args);
    expect(result).toEqual({ sent: true, email: "alice@example.com" });
  });

  it("returns sent=true for empty email without calling backend", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const formData = new FormData();
    formData.set("email", "");
    const request = new Request("http://localhost/forgot-password", {
      method: "POST",
      body: formData,
    });
    const args = { request, params: {}, context: {} } as unknown as ActionFunctionArgs;
    const result = await action(args);
    expect(result).toEqual({ sent: true, email: "" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("ForgotPassword route — component (form state)", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders email field and submit button in initial state", async () => {
    const ForgotPasswordRoute = (await import("./forgot-password.js")).default;
    mockUseActionData.mockReturnValue(undefined);
    mockUseNavigation.mockReturnValue({ state: "idle" } as ReturnType<typeof useNavigation>);

    render(<ForgotPasswordRoute />);

    expect(screen.getByLabelText("password_reset.forgot.email_label")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "password_reset.forgot.submit" }),
    ).toBeTruthy();
  });

  it("disables submit button while submitting", async () => {
    const ForgotPasswordRoute = (await import("./forgot-password.js")).default;
    mockUseActionData.mockReturnValue(undefined);
    mockUseNavigation.mockReturnValue({ state: "submitting" } as ReturnType<typeof useNavigation>);

    render(<ForgotPasswordRoute />);

    const button = screen.getByRole("button", {
      name: "password_reset.forgot.submit_loading",
    });
    expect(button).toHaveProperty("disabled", true);
  });
});

describe("ForgotPassword route — component (success state)", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders success state when actionData.sent is true", async () => {
    const ForgotPasswordRoute = (await import("./forgot-password.js")).default;
    mockUseActionData.mockReturnValue({ sent: true, email: "alice@example.com" });
    mockUseNavigation.mockReturnValue({ state: "idle" } as ReturnType<typeof useNavigation>);

    render(<ForgotPasswordRoute />);

    expect(screen.getByText("password_reset.forgot.success_title")).toBeTruthy();
    expect(screen.getByText("password_reset.forgot.success_message")).toBeTruthy();
    expect(screen.getByText("alice@example.com")).toBeTruthy();
  });

  it("shows success state regardless of which email was submitted", async () => {
    const ForgotPasswordRoute = (await import("./forgot-password.js")).default;
    mockUseActionData.mockReturnValue({ sent: true, email: "unknown@example.com" });
    mockUseNavigation.mockReturnValue({ state: "idle" } as ReturnType<typeof useNavigation>);

    render(<ForgotPasswordRoute />);

    expect(screen.getByText("password_reset.forgot.success_title")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "password_reset.forgot.submit" })).toBeNull();
  });
});
