import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
      to,
      children,
      ...props
    }: { to: string; children: React.ReactNode } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
      <a href={to} {...props}>{children}</a>
    ),
    redirect: vi.fn((url: string) => new Response(null, { status: 302, headers: { Location: url } })),
    useActionData: vi.fn(() => undefined),
    useLoaderData: vi.fn(() => ({ token: "valid-token-abc" })),
    useNavigation: vi.fn(() => ({ state: "idle" })),
  };
});

vi.mock("@tolgee/react", () => ({
  useTranslate: () => ({
    t: (key: string) => key,
  }),
}));

import { useActionData, useLoaderData, useNavigation } from "react-router";
import { action, loader } from "./reset-password.js";

const mockUseActionData = vi.mocked(useActionData);
const mockUseLoaderData = vi.mocked(useLoaderData);
const mockUseNavigation = vi.mocked(useNavigation);

describe("ResetPassword route — loader", () => {
  it("extracts the token from the query string", () => {
    const request = new Request("http://localhost/reset-password?token=abc123");
    const args = { request, params: {}, context: {} } as unknown as LoaderFunctionArgs;
    const result = loader(args);
    expect(result).toEqual({ token: "abc123" });
  });

  it("returns empty string when no token query param is present", () => {
    const request = new Request("http://localhost/reset-password");
    const args = { request, params: {}, context: {} } as unknown as LoaderFunctionArgs;
    const result = loader(args);
    expect(result).toEqual({ token: "" });
  });

  it("extracts the token from a complex URL with multiple params", () => {
    const request = new Request(
      "http://localhost/reset-password?token=xyz-token-99&foo=bar",
    );
    const args = { request, params: {}, context: {} } as unknown as LoaderFunctionArgs;
    const result = loader(args);
    expect(result).toEqual({ token: "xyz-token-99" });
  });
});

describe("ResetPassword route — action", () => {
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

  it("redirects to /login?reset=success on successful reset", async () => {
    const formData = new FormData();
    formData.set("token", "valid-token");
    formData.set("newPassword", "Str0ng-Passphrase-42");
    formData.set("confirmPassword", "Str0ng-Passphrase-42");

    const request = new Request("http://localhost/reset-password", {
      method: "POST",
      body: formData,
    });
    const args = { request, params: {}, context: {} } as unknown as ActionFunctionArgs;
    const result = await action(args);
    expect(result).toBeInstanceOf(Response);
    const res = result as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login?reset=success");
  });

  it("returns missing token error when no token is provided", async () => {
    const formData = new FormData();
    formData.set("token", "");
    formData.set("newPassword", "Str0ng-Passphrase-42");
    formData.set("confirmPassword", "Str0ng-Passphrase-42");

    const request = new Request("http://localhost/reset-password", {
      method: "POST",
      body: formData,
    });
    const args = { request, params: {}, context: {} } as unknown as ActionFunctionArgs;
    const result = await action(args);
    expect(result).toEqual({ error: "password_reset.set.error_missing_token" });
  });

  it("returns passwords mismatch error when passwords differ", async () => {
    const formData = new FormData();
    formData.set("token", "valid-token");
    formData.set("newPassword", "Str0ng-Passphrase-42");
    formData.set("confirmPassword", "Different-Passphrase-99");

    const request = new Request("http://localhost/reset-password", {
      method: "POST",
      body: formData,
    });
    const args = { request, params: {}, context: {} } as unknown as ActionFunctionArgs;
    const result = await action(args);
    expect(result).toEqual({ error: "password_reset.set.error_passwords_mismatch" });
  });

  it("returns token invalid error on 422 response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: "Token expired or invalid" }), {
          status: 422,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const formData = new FormData();
    formData.set("token", "expired-token");
    formData.set("newPassword", "Str0ng-Passphrase-42");
    formData.set("confirmPassword", "Str0ng-Passphrase-42");

    const request = new Request("http://localhost/reset-password", {
      method: "POST",
      body: formData,
    });
    const args = { request, params: {}, context: {} } as unknown as ActionFunctionArgs;
    const result = await action(args);
    expect(result).toEqual({ error: "password_reset.set.error_token_invalid" });
  });

  it("returns generic error on network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));

    const formData = new FormData();
    formData.set("token", "valid-token");
    formData.set("newPassword", "Str0ng-Passphrase-42");
    formData.set("confirmPassword", "Str0ng-Passphrase-42");

    const request = new Request("http://localhost/reset-password", {
      method: "POST",
      body: formData,
    });
    const args = { request, params: {}, context: {} } as unknown as ActionFunctionArgs;
    const result = await action(args);
    expect(result).toEqual({ error: "password_reset.set.error_generic" });
  });
});

describe("ResetPassword route — component", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the new password and confirm password fields when token is present", async () => {
    const ResetPasswordRoute = (await import("./reset-password.js")).default;
    mockUseLoaderData.mockReturnValue({ token: "valid-token-abc" });
    mockUseActionData.mockReturnValue(undefined);
    mockUseNavigation.mockReturnValue({ state: "idle" } as ReturnType<typeof useNavigation>);

    render(<ResetPasswordRoute />);

    expect(screen.getByLabelText("password_reset.set.new_password_label")).toBeTruthy();
    expect(screen.getByLabelText("password_reset.set.confirm_password_label")).toBeTruthy();
  });

  it("shows missing-token error state when token is empty", async () => {
    const ResetPasswordRoute = (await import("./reset-password.js")).default;
    mockUseLoaderData.mockReturnValue({ token: "" });
    mockUseActionData.mockReturnValue(undefined);
    mockUseNavigation.mockReturnValue({ state: "idle" } as ReturnType<typeof useNavigation>);

    render(<ResetPasswordRoute />);

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("password_reset.set.error_missing_token")).toBeTruthy();
  });

  it("shows server-side error banner when action returns an error key", async () => {
    const ResetPasswordRoute = (await import("./reset-password.js")).default;
    mockUseLoaderData.mockReturnValue({ token: "valid-token-abc" });
    mockUseActionData.mockReturnValue({ error: "password_reset.set.error_token_invalid" });
    mockUseNavigation.mockReturnValue({ state: "idle" } as ReturnType<typeof useNavigation>);

    render(<ResetPasswordRoute />);

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("password_reset.set.error_token_invalid")).toBeTruthy();
  });

  it("disables submit button when passwords are empty", async () => {
    const ResetPasswordRoute = (await import("./reset-password.js")).default;
    mockUseLoaderData.mockReturnValue({ token: "valid-token-abc" });
    mockUseActionData.mockReturnValue(undefined);
    mockUseNavigation.mockReturnValue({ state: "idle" } as ReturnType<typeof useNavigation>);

    render(<ResetPasswordRoute />);

    const button = screen.getByRole("button", { name: "password_reset.set.submit" });
    expect(button).toHaveProperty("disabled", true);
  });

  it("shows passwords_mismatch hint when confirm password differs from new password", async () => {
    const ResetPasswordRoute = (await import("./reset-password.js")).default;
    mockUseLoaderData.mockReturnValue({ token: "valid-token-abc" });
    mockUseActionData.mockReturnValue(undefined);
    mockUseNavigation.mockReturnValue({ state: "idle" } as ReturnType<typeof useNavigation>);

    render(<ResetPasswordRoute />);

    const newInput = screen.getByLabelText("password_reset.set.new_password_label");
    const confirmInput = screen.getByLabelText("password_reset.set.confirm_password_label");

    fireEvent.change(newInput, { target: { value: "Str0ng-Passphrase-42" } });
    fireEvent.change(confirmInput, { target: { value: "Different-Value-99" } });

    expect(screen.getByText("password_reset.set.passwords_mismatch")).toBeTruthy();
  });

  it("shows passwords_match hint when confirm password matches new password", async () => {
    const ResetPasswordRoute = (await import("./reset-password.js")).default;
    mockUseLoaderData.mockReturnValue({ token: "valid-token-abc" });
    mockUseActionData.mockReturnValue(undefined);
    mockUseNavigation.mockReturnValue({ state: "idle" } as ReturnType<typeof useNavigation>);

    render(<ResetPasswordRoute />);

    const newInput = screen.getByLabelText("password_reset.set.new_password_label");
    const confirmInput = screen.getByLabelText("password_reset.set.confirm_password_label");

    fireEvent.change(newInput, { target: { value: "Str0ng-Passphrase-42" } });
    fireEvent.change(confirmInput, { target: { value: "Str0ng-Passphrase-42" } });

    expect(screen.getByText("password_reset.set.passwords_match")).toBeTruthy();
  });

  it("enables submit button when passwords match and meet minimum length", async () => {
    const ResetPasswordRoute = (await import("./reset-password.js")).default;
    mockUseLoaderData.mockReturnValue({ token: "valid-token-abc" });
    mockUseActionData.mockReturnValue(undefined);
    mockUseNavigation.mockReturnValue({ state: "idle" } as ReturnType<typeof useNavigation>);

    render(<ResetPasswordRoute />);

    const newInput = screen.getByLabelText("password_reset.set.new_password_label");
    const confirmInput = screen.getByLabelText("password_reset.set.confirm_password_label");

    fireEvent.change(newInput, { target: { value: "Str0ng-Passphrase-42" } });
    fireEvent.change(confirmInput, { target: { value: "Str0ng-Passphrase-42" } });

    const button = screen.getByRole("button", { name: "password_reset.set.submit" });
    expect(button).toHaveProperty("disabled", false);
  });
});
