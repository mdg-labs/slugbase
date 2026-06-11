import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Minimal stubs for React Router and i18n so tests run without full providers
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
    useLoaderData: vi.fn(() => ({ passwordReset: false, oidcProviders: [] })),
    useNavigation: vi.fn(() => ({ state: "idle" })),
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("../../lib/session-client.js", () => ({
  getSessionUser: vi.fn().mockResolvedValue(null),
}));

import { useActionData, useNavigation } from "react-router";
import { action, loader } from "./login.js";

const mockUseActionData = vi.mocked(useActionData);
const mockUseNavigation = vi.mocked(useNavigation);

describe("Login route - loader", () => {
  it("returns empty object when unauthenticated", async () => {
    const { getSessionUser } = await import("../../lib/session-client.js");
    vi.mocked(getSessionUser).mockResolvedValueOnce(null);

    const request = new Request("http://localhost/login");
    const args = { request, params: {}, context: {} } as unknown as LoaderFunctionArgs;
    const result = await loader(args);
    expect(result).toMatchObject({ passwordReset: false, oidcProviders: [] });
  });

  it("redirects to / when session is already valid", async () => {
    const { getSessionUser } = await import("../../lib/session-client.js");
    vi.mocked(getSessionUser).mockResolvedValueOnce({
      id: "user-1",
      email: "alice@example.com",
      name: "Alice",
      language: "en",
      mfaState: "not_enrolled",
      emailVerified: true,
    });

    const request = new Request("http://localhost/login");
    const args = { request, params: {}, context: {} } as unknown as LoaderFunctionArgs;
    // redirect() returns a Response, not throws - it rejects because we call `return redirect()`
    // which React Router treats as a redirect, not an exception in our action
    const result = await loader(args);
    expect(result).toBeInstanceOf(Response);
    const res = result as Response;
    expect(res.headers.get("Location")).toBe("/");
  });
});

describe("Login route - action", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ userId: "user-1" }), {
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

  it("redirects to / on successful login", async () => {
    const formData = new FormData();
    formData.set("email", "alice@example.com");
    formData.set("password", "correct-password");

    const request = new Request("http://localhost/login", {
      method: "POST",
      body: formData,
    });

    const args = { request, params: {}, context: {} } as unknown as ActionFunctionArgs;
    const result = await action(args);
    expect(result).toBeInstanceOf(Response);
    const res = result as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/");
  });

  it("returns error key on 401 (non-enumerating)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: "Invalid email or password" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const formData = new FormData();
    formData.set("email", "alice@example.com");
    formData.set("password", "wrong-password");

    const request = new Request("http://localhost/login", {
      method: "POST",
      body: formData,
    });

    const args = { request, params: {}, context: {} } as unknown as ActionFunctionArgs;
    const result = await action(args);
    expect(result).toEqual({ error: "auth.login.error_invalid" });
  });

  it("returns generic error key on network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));

    const formData = new FormData();
    formData.set("email", "alice@example.com");
    formData.set("password", "any-password");

    const request = new Request("http://localhost/login", {
      method: "POST",
      body: formData,
    });

    const args = { request, params: {}, context: {} } as unknown as ActionFunctionArgs;
    const result = await action(args);
    expect(result).toEqual({ error: "auth.login.error_generic" });
  });

  it("returns error key for empty credentials", async () => {
    const formData = new FormData();
    formData.set("email", "");
    formData.set("password", "");

    const request = new Request("http://localhost/login", {
      method: "POST",
      body: formData,
    });

    const args = { request, params: {}, context: {} } as unknown as ActionFunctionArgs;
    const result = await action(args);
    expect(result).toEqual({ error: "auth.login.error_invalid" });
  });

  it("redirects to /verify-email when login requires email verification", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ userId: "user-1", emailVerificationRequired: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const formData = new FormData();
    formData.set("email", "pending@example.com");
    formData.set("password", "correct-password");

    const request = new Request("http://localhost/login", {
      method: "POST",
      body: formData,
    });

    const args = { request, params: {}, context: {} } as unknown as ActionFunctionArgs;
    const result = await action(args);
    const res = result as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/verify-email");
  });

  it("redirects unverified session to verify-email", async () => {
    const { getSessionUser } = await import("../../lib/session-client.js");
    vi.mocked(getSessionUser).mockResolvedValueOnce({
      id: "user-1",
      email: "pending@example.com",
      name: "Pending",
      language: "en",
      mfaState: "not_enrolled",
      emailVerified: false,
    });

    const request = new Request("http://localhost/login");
    const args = { request, params: {}, context: {} } as unknown as LoaderFunctionArgs;
    const result = await loader(args);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).headers.get("Location")).toBe("/verify-email");
  });

  it("redirects to /mfa when MFA is required", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ mfaRequired: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const formData = new FormData();
    formData.set("email", "mfa@example.com");
    formData.set("password", "correct-password");

    const request = new Request("http://localhost/login", {
      method: "POST",
      body: formData,
    });

    const args = { request, params: {}, context: {} } as unknown as ActionFunctionArgs;
    const result = await action(args);
    const res = result as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/mfa");
  });
});

describe("Login route - component", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders sign-in form with email and password fields", async () => {
    const LoginRoute = (await import("./login.js")).default;
    mockUseActionData.mockReturnValue(undefined);
    mockUseNavigation.mockReturnValue({ state: "idle" } as ReturnType<typeof useNavigation>);

    render(<LoginRoute />);

    expect(screen.getByLabelText("auth.login.email_label")).toBeTruthy();
    expect(screen.getByLabelText("auth.login.password_label")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "auth.login.submit" }),
    ).toBeTruthy();
  });

  it("renders an error banner when action returns an error key", async () => {
    const LoginRoute = (await import("./login.js")).default;
    mockUseActionData.mockReturnValue({ error: "auth.login.error_invalid" });
    mockUseNavigation.mockReturnValue({ state: "idle" } as ReturnType<typeof useNavigation>);

    render(<LoginRoute />);

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(
      screen.getByText("auth.login.error_invalid"),
    ).toBeTruthy();
  });

  it("disables submit button while submitting", async () => {
    const LoginRoute = (await import("./login.js")).default;
    mockUseActionData.mockReturnValue(undefined);
    mockUseNavigation.mockReturnValue({ state: "submitting" } as ReturnType<typeof useNavigation>);

    render(<LoginRoute />);

    const button = screen.getByRole("button", { name: "auth.login.submit_loading" });
    expect(button).toHaveProperty("disabled", true);
  });

  it("toggles password visibility on show/hide button click", async () => {
    const LoginRoute = (await import("./login.js")).default;
    mockUseActionData.mockReturnValue(undefined);
    mockUseNavigation.mockReturnValue({ state: "idle" } as ReturnType<typeof useNavigation>);

    render(<LoginRoute />);

    const passwordInput = screen.getByLabelText("auth.login.password_label");
    expect((passwordInput as HTMLInputElement).type).toBe("password");

    const showButton = screen.getByLabelText("auth.login.password_show");
    fireEvent.click(showButton);

    await waitFor(() => {
      expect((passwordInput as HTMLInputElement).type).toBe("text");
    });
  });
});
