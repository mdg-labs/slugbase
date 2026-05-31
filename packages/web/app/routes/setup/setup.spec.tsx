import { cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react";
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
    useNavigation: vi.fn(() => ({ state: "idle" })),
  };
});

vi.mock("@tolgee/react", () => ({
  useTranslate: () => ({ t: (key: string) => key }),
}));

import { useActionData, useNavigation } from "react-router";
import { action, loader } from "./setup.js";

const mockUseActionData = vi.mocked(useActionData);
const mockUseNavigation = vi.mocked(useNavigation);

describe("Setup route — loader", () => {
  beforeEach(() => {
    process.env["API_BASE_URL"] = "http://localhost:3000";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env["API_BASE_URL"];
  });

  it("returns empty object when needsSetup is true", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ needsSetup: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const request = new Request("http://localhost/setup");
    const args = { request, params: {}, context: {} } as unknown as LoaderFunctionArgs;
    const result = await loader(args);
    expect(result).toEqual({});
  });

  it("redirects to /login when setup is already complete", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ needsSetup: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const request = new Request("http://localhost/setup");
    const args = { request, params: {}, context: {} } as unknown as LoaderFunctionArgs;
    const result = await loader(args);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).headers.get("Location")).toBe("/login");
  });

  it("returns empty object when backend is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));

    const request = new Request("http://localhost/setup");
    const args = { request, params: {}, context: {} } as unknown as LoaderFunctionArgs;
    const result = await loader(args);
    expect(result).toEqual({});
  });
});

describe("Setup route — action", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ userId: "admin-1" }), {
          status: 201,
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

  function makeFormData(overrides: Record<string, string> = {}) {
    const fd = new FormData();
    fd.set("name", "Admin User");
    fd.set("email", "admin@example.com");
    fd.set("password", "AdminP@ss1");
    fd.set("workspaceName", "My Company");
    fd.set("workspaceSlug", "my-company");
    for (const [key, value] of Object.entries(overrides)) {
      fd.set(key, value);
    }
    return fd;
  }

  it("redirects to /login on successful setup", async () => {
    const request = new Request("http://localhost/setup", {
      method: "POST",
      body: makeFormData(),
    });
    const args = { request, params: {}, context: {} } as unknown as ActionFunctionArgs;
    const result = await action(args);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(302);
    expect((result as Response).headers.get("Location")).toBe("/login");
  });

  it("returns setup.error_already_done on 409", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: "Already set up" }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const request = new Request("http://localhost/setup", {
      method: "POST",
      body: makeFormData(),
    });
    const args = { request, params: {}, context: {} } as unknown as ActionFunctionArgs;
    const result = await action(args);

    expect(result).toEqual({ error: "setup.error_already_done" });
  });

  it("validates email format", async () => {
    const request = new Request("http://localhost/setup", {
      method: "POST",
      body: makeFormData({ email: "bad-email" }),
    });
    const args = { request, params: {}, context: {} } as unknown as ActionFunctionArgs;
    const result = await action(args);

    expect(result).toEqual({ error: "setup.error_invalid_email" });
  });

  it("validates minimum password length", async () => {
    const request = new Request("http://localhost/setup", {
      method: "POST",
      body: makeFormData({ password: "short" }),
    });
    const args = { request, params: {}, context: {} } as unknown as ActionFunctionArgs;
    const result = await action(args);

    expect(result).toEqual({ error: "setup.error_password_too_short" });
  });

  it("validates workspace slug format", async () => {
    const request = new Request("http://localhost/setup", {
      method: "POST",
      body: makeFormData({ workspaceSlug: "My Company!" }),
    });
    const args = { request, params: {}, context: {} } as unknown as ActionFunctionArgs;
    const result = await action(args);

    expect(result).toEqual({ error: "setup.error_invalid_slug" });
  });

  it("returns generic error on network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));

    const request = new Request("http://localhost/setup", {
      method: "POST",
      body: makeFormData(),
    });
    const args = { request, params: {}, context: {} } as unknown as ActionFunctionArgs;
    const result = await action(args);

    expect(result).toEqual({ error: "setup.error_generic" });
  });
});

describe("Setup route — component", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders all required fields", async () => {
    const SetupRoute = (await import("./setup.js")).default;
    mockUseActionData.mockReturnValue(undefined);
    mockUseNavigation.mockReturnValue({ state: "idle" } as ReturnType<typeof useNavigation>);

    render(<SetupRoute />);

    expect(screen.getByLabelText("setup.name_label")).toBeTruthy();
    expect(screen.getByLabelText("setup.email_label")).toBeTruthy();
    expect(screen.getByLabelText("setup.password_label")).toBeTruthy();
    expect(screen.getByLabelText("setup.workspace_name_label")).toBeTruthy();
    expect(screen.getByLabelText("setup.workspace_slug_label")).toBeTruthy();
    expect(screen.getByRole("button", { name: "setup.submit" })).toBeTruthy();
  });

  it("shows error banner when action returns an error key", async () => {
    const SetupRoute = (await import("./setup.js")).default;
    mockUseActionData.mockReturnValue({ error: "setup.error_already_done" });
    mockUseNavigation.mockReturnValue({ state: "idle" } as ReturnType<typeof useNavigation>);

    render(<SetupRoute />);

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("setup.error_already_done")).toBeTruthy();
  });

  it("disables submit button while submitting", async () => {
    const SetupRoute = (await import("./setup.js")).default;
    mockUseActionData.mockReturnValue(undefined);
    mockUseNavigation.mockReturnValue({ state: "submitting" } as ReturnType<typeof useNavigation>);

    render(<SetupRoute />);

    const button = screen.getByRole("button", { name: "setup.submit_loading" });
    expect(button).toHaveProperty("disabled", true);
  });

  it("shows password strength indicator when password is typed", async () => {
    const SetupRoute = (await import("./setup.js")).default;
    mockUseActionData.mockReturnValue(undefined);
    mockUseNavigation.mockReturnValue({ state: "idle" } as ReturnType<typeof useNavigation>);

    render(<SetupRoute />);

    const passwordInput = screen.getByLabelText("setup.password_label");
    fireEvent.change(passwordInput, { target: { value: "abc12345" } });

    await waitFor(() => {
      expect(screen.getByText("setup.password_strength.weak")).toBeTruthy();
    });
  });

  it("auto-derives workspace slug from workspace name", async () => {
    const SetupRoute = (await import("./setup.js")).default;
    mockUseActionData.mockReturnValue(undefined);
    mockUseNavigation.mockReturnValue({ state: "idle" } as ReturnType<typeof useNavigation>);

    render(<SetupRoute />);

    const workspaceNameInput = screen.getByLabelText("setup.workspace_name_label");
    fireEvent.change(workspaceNameInput, { target: { value: "Acme Inc" } });

    await waitFor(() => {
      const slugInput = screen.getByLabelText("setup.workspace_slug_label");
      expect((slugInput as HTMLInputElement).value).toBe("acme-inc");
    });
  });
});
