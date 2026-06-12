import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    redirect: vi.fn((url: string) => new Response(null, { status: 302, headers: { Location: url } })),
    useActionData: vi.fn(() => undefined),
    useLoaderData: vi.fn(() => ({ oidcProviders: [] })),
    useNavigation: vi.fn(() => ({ state: "idle" })),
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../../lib/session-client.js", () => ({
  getSessionUser: vi.fn().mockResolvedValue(null),
}));

import { useActionData, useNavigation } from "react-router";
import { action, loader, readApiSessionCookie } from "./register.js";

const mockUseActionData = vi.mocked(useActionData);
const mockUseNavigation = vi.mocked(useNavigation);

describe("Register route - loader", () => {
  it("returns empty object when unauthenticated", async () => {
    const { getSessionUser } = await import("../../lib/session-client.js");
    vi.mocked(getSessionUser).mockResolvedValueOnce(null);

    const request = new Request("http://localhost/register");
    const args = { request, params: {}, context: {} } as unknown as LoaderFunctionArgs;
    const result = await loader(args);
    expect(result).toMatchObject({ oidcProviders: [] });
  });

  it("redirects to / when already authenticated", async () => {
    const { getSessionUser } = await import("../../lib/session-client.js");
    vi.mocked(getSessionUser).mockResolvedValueOnce({
      id: "user-1",
      email: "alice@example.com",
      name: "Alice",
      language: "en",
      mfaState: "not_enrolled",
      emailVerified: true,
    });

    const request = new Request("http://localhost/register");
    const args = { request, params: {}, context: {} } as unknown as LoaderFunctionArgs;
    const result = await loader(args);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).headers.get("Location")).toBe("/");
  });
});

describe("Register route - action", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ userId: "user-1" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    process.env["API_BASE_URL"] = "http://localhost:3000";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env["API_BASE_URL"];
  });

  it("redirects to / on successful registration", async () => {
    const apiResponse = new Response(JSON.stringify({ userId: "user-1" }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
    vi.spyOn(apiResponse.headers, "getSetCookie").mockReturnValue([
      "slugbase_session=abc; Path=/; HttpOnly",
    ]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(apiResponse));

    const formData = new FormData();
    formData.set("name", "Alice");
    formData.set("email", "alice@example.com");
    formData.set("password", "s3cure-P@ss");

    const request = new Request("http://localhost/register", { method: "POST", body: formData });
    const args = { request, params: {}, context: {} } as unknown as ActionFunctionArgs;
    const result = await action(args);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(303);
    expect((result as Response).headers.get("Location")).toBe("/");
    expect((result as Response).headers.get("Set-Cookie")).toBe(
      "slugbase_session=abc; Path=/; HttpOnly",
    );
  });

  it("readApiSessionCookie prefers getSetCookie when available", () => {
    const res = {
      headers: {
        getSetCookie: () => ["slugbase_session=abc; Path=/; HttpOnly"],
        get: () => null,
      },
    } as unknown as Response;

    expect(readApiSessionCookie(res)).toBe("slugbase_session=abc; Path=/; HttpOnly");
  });

  it("returns register.error_disabled on 403", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: "Registration disabled" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const formData = new FormData();
    formData.set("name", "Alice");
    formData.set("email", "alice@example.com");
    formData.set("password", "s3cure-P@ss");

    const request = new Request("http://localhost/register", { method: "POST", body: formData });
    const args = { request, params: {}, context: {} } as unknown as ActionFunctionArgs;
    const result = await action(args);

    expect(result).toEqual({ error: "register.error_disabled" });
  });

  it("returns register.error_email_taken on 409", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: "Email in use" }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const formData = new FormData();
    formData.set("name", "Alice");
    formData.set("email", "alice@example.com");
    formData.set("password", "s3cure-P@ss");

    const request = new Request("http://localhost/register", { method: "POST", body: formData });
    const args = { request, params: {}, context: {} } as unknown as ActionFunctionArgs;
    const result = await action(args);

    expect(result).toEqual({ error: "register.error_email_taken" });
  });

  it("validates email format client-side", async () => {
    const formData = new FormData();
    formData.set("name", "Alice");
    formData.set("email", "not-an-email");
    formData.set("password", "s3cure-P@ss");

    const request = new Request("http://localhost/register", { method: "POST", body: formData });
    const args = { request, params: {}, context: {} } as unknown as ActionFunctionArgs;
    const result = await action(args);

    expect(result).toEqual({ error: "register.error_invalid_email" });
  });

  it("validates minimum password length", async () => {
    const formData = new FormData();
    formData.set("name", "Alice");
    formData.set("email", "alice@example.com");
    formData.set("password", "short");

    const request = new Request("http://localhost/register", { method: "POST", body: formData });
    const args = { request, params: {}, context: {} } as unknown as ActionFunctionArgs;
    const result = await action(args);

    expect(result).toEqual({ error: "register.error_password_too_short" });
  });

  it("redirects to verify-email when backend signals verification required", async () => {
    const apiResponse = new Response(
      JSON.stringify({ userId: "user-1", emailVerificationRequired: true }),
      { status: 201, headers: { "Content-Type": "application/json" } },
    );
    vi.spyOn(apiResponse.headers, "getSetCookie").mockReturnValue([
      "slugbase_session=verify; Path=/; HttpOnly",
    ]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(apiResponse));

    const formData = new FormData();
    formData.set("name", "Alice");
    formData.set("email", "alice@example.com");
    formData.set("password", "s3cure-P@ss");

    const request = new Request("http://localhost/register", { method: "POST", body: formData });
    const args = { request, params: {}, context: {} } as unknown as ActionFunctionArgs;
    const result = await action(args);

    expect(result).toBeInstanceOf(Response);
    const res = result as Response;
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/verify-email");
    expect(res.headers.get("Set-Cookie")).toBe("slugbase_session=verify; Path=/; HttpOnly");
  });

  it("returns generic error on network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));

    const formData = new FormData();
    formData.set("name", "Alice");
    formData.set("email", "alice@example.com");
    formData.set("password", "s3cure-P@ss");

    const request = new Request("http://localhost/register", { method: "POST", body: formData });
    const args = { request, params: {}, context: {} } as unknown as ActionFunctionArgs;
    const result = await action(args);

    expect(result).toEqual({ error: "register.error_generic" });
  });
});

describe("Register route - component", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders name, email, and password fields", async () => {
    const RegisterRoute = (await import("./register.js")).default;
    mockUseActionData.mockReturnValue(undefined);
    mockUseNavigation.mockReturnValue({ state: "idle" } as ReturnType<typeof useNavigation>);

    render(<RegisterRoute />);

    expect(screen.getByLabelText("register.name_label")).toBeTruthy();
    expect(screen.getByLabelText("register.email_label")).toBeTruthy();
    expect(screen.getByLabelText("register.password_label")).toBeTruthy();
    expect(screen.getByRole("button", { name: "register.submit" })).toBeTruthy();
  });

  it("shows error banner when action returns an error key", async () => {
    const RegisterRoute = (await import("./register.js")).default;
    mockUseActionData.mockReturnValue({ error: "register.error_email_taken" });
    mockUseNavigation.mockReturnValue({ state: "idle" } as ReturnType<typeof useNavigation>);

    render(<RegisterRoute />);

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("register.error_email_taken")).toBeTruthy();
  });

  it("renders registration-disabled screen when error is register.error_disabled", async () => {
    const RegisterRoute = (await import("./register.js")).default;
    mockUseActionData.mockReturnValue({ error: "register.error_disabled" });
    mockUseNavigation.mockReturnValue({ state: "idle" } as ReturnType<typeof useNavigation>);

    render(<RegisterRoute />);

    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByText("register.error_disabled")).toBeTruthy();
  });

  it("disables submit button while submitting", async () => {
    const RegisterRoute = (await import("./register.js")).default;
    mockUseActionData.mockReturnValue(undefined);
    mockUseNavigation.mockReturnValue({ state: "submitting" } as ReturnType<typeof useNavigation>);

    render(<RegisterRoute />);

    const button = screen.getByRole("button", { name: "register.submit_loading" });
    expect(button).toHaveProperty("disabled", true);
  });

  it("shows password strength indicator when password is typed", async () => {
    const RegisterRoute = (await import("./register.js")).default;
    mockUseActionData.mockReturnValue(undefined);
    mockUseNavigation.mockReturnValue({ state: "idle" } as ReturnType<typeof useNavigation>);

    render(<RegisterRoute />);

    const passwordInput = screen.getByLabelText("register.password_label");
    fireEvent.change(passwordInput, { target: { value: "abc12345" } });

    await waitFor(() => {
      expect(screen.getByText("register.password_strength.weak")).toBeTruthy();
    });
  });

  it("links to /login for existing users", async () => {
    const RegisterRoute = (await import("./register.js")).default;
    mockUseActionData.mockReturnValue(undefined);
    mockUseNavigation.mockReturnValue({ state: "idle" } as ReturnType<typeof useNavigation>);

    render(<RegisterRoute />);

    const link = screen.getByText("register.sign_in_link");
    expect(link.closest("a")).toHaveProperty("href");
    expect(link.closest("a")?.getAttribute("href")).toContain("/login");
  });
});
