import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ActionFunctionArgs } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-router", async (importOriginal) => {
  const original = await importOriginal<typeof import("react-router")>();
  return {
    ...original,
    Form: ({
      children,
      ...props
    }: React.FormHTMLAttributes<HTMLFormElement> & {
      children: React.ReactNode;
    }) => <form {...props}>{children}</form>,
    redirect: vi.fn(
      (url: string) =>
        new Response(null, { status: 302, headers: { Location: url } }),
    ),
    useActionData: vi.fn(() => undefined),
    useNavigation: vi.fn(() => ({ state: "idle" })),
    useLoaderData: vi.fn(() => ({})),
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

import { useActionData, useNavigation } from "react-router";

const mockUseActionData = vi.mocked(useActionData);
const mockUseNavigation = vi.mocked(useNavigation);

describe("MFA challenge route — action", () => {
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

  it("returns error key for empty code", async () => {
    const { action } = await import("./challenge.js");
    const formData = new FormData();
    formData.set("code", "");
    const request = new Request("http://localhost/mfa", {
      method: "POST",
      body: formData,
    });
    const args = {
      request,
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs;
    const result = await action(args);
    expect(result).toEqual({ error: "mfa.challenge.error_invalid" });
  });

  it("redirects to / on successful challenge", async () => {
    const { action } = await import("./challenge.js");
    const formData = new FormData();
    formData.set("code", "123456");
    const request = new Request("http://localhost/mfa", {
      method: "POST",
      body: formData,
    });
    const args = {
      request,
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs;
    const result = await action(args);
    expect(result).toBeInstanceOf(Response);
    const res = result as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/");
  });

  it("returns error_invalid on 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: "Invalid code" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const { action } = await import("./challenge.js");
    const formData = new FormData();
    formData.set("code", "000000");
    const request = new Request("http://localhost/mfa", {
      method: "POST",
      body: formData,
    });
    const args = {
      request,
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs;
    const result = await action(args);
    expect(result).toEqual({ error: "mfa.challenge.error_invalid" });
  });

  it("returns error_generic on network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));

    const { action } = await import("./challenge.js");
    const formData = new FormData();
    formData.set("code", "123456");
    const request = new Request("http://localhost/mfa", {
      method: "POST",
      body: formData,
    });
    const args = {
      request,
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs;
    const result = await action(args);
    expect(result).toEqual({ error: "mfa.challenge.error_generic" });
  });
});

describe("MFA challenge route — component", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders in TOTP mode by default with 6 digit inputs", async () => {
    const MfaChallengeRoute = (await import("./challenge.js")).default;
    mockUseActionData.mockReturnValue(undefined);
    mockUseNavigation.mockReturnValue({
      state: "idle",
    } as ReturnType<typeof useNavigation>);

    render(<MfaChallengeRoute />);

    expect(screen.getByText("mfa.challenge.title")).toBeTruthy();
    expect(screen.getByText("mfa.challenge.subtitle_totp")).toBeTruthy();

    const digitInputs = screen.getAllByRole("textbox");
    const codeDigits = digitInputs.filter(
      (el) => (el as HTMLInputElement).maxLength === 1,
    );
    expect(codeDigits).toHaveLength(6);
  });

  it("toggles to backup mode when toggle button is clicked", async () => {
    const MfaChallengeRoute = (await import("./challenge.js")).default;
    mockUseActionData.mockReturnValue(undefined);
    mockUseNavigation.mockReturnValue({
      state: "idle",
    } as ReturnType<typeof useNavigation>);

    render(<MfaChallengeRoute />);

    const toggleButton = screen.getByRole("button", {
      name: "mfa.challenge.toggle_use_backup",
    });
    fireEvent.click(toggleButton);

    await waitFor(() => {
      expect(screen.getByText("mfa.challenge.subtitle_backup")).toBeTruthy();
    });

    const backupInput = screen.getByLabelText("mfa.challenge.label_backup_code");
    expect(backupInput).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "mfa.challenge.toggle_use_totp" }),
    ).toBeTruthy();
  });

  it("submit button is disabled when fewer than 6 TOTP digits are entered", async () => {
    const MfaChallengeRoute = (await import("./challenge.js")).default;
    mockUseActionData.mockReturnValue(undefined);
    mockUseNavigation.mockReturnValue({
      state: "idle",
    } as ReturnType<typeof useNavigation>);

    render(<MfaChallengeRoute />);

    const submitButton = screen.getByRole("button", {
      name: "mfa.challenge.submit",
    });
    expect(submitButton).toHaveProperty("disabled", true);
  });

  it("submit button becomes enabled after entering 6 digits", async () => {
    const MfaChallengeRoute = (await import("./challenge.js")).default;
    mockUseActionData.mockReturnValue(undefined);
    mockUseNavigation.mockReturnValue({
      state: "idle",
    } as ReturnType<typeof useNavigation>);

    render(<MfaChallengeRoute />);

    const digitInputs = screen
      .getAllByRole("textbox")
      .filter((el) => (el as HTMLInputElement).maxLength === 1);

    digitInputs.forEach((input, i) => {
      fireEvent.change(input, { target: { value: String(i + 1) } });
    });

    await waitFor(() => {
      const submitButton = screen.getByRole("button", {
        name: "mfa.challenge.submit",
      });
      expect(submitButton).toHaveProperty("disabled", false);
    });
  });

  it("shows error banner when action returns an error key", async () => {
    const MfaChallengeRoute = (await import("./challenge.js")).default;
    mockUseActionData.mockReturnValue({
      error: "mfa.challenge.error_invalid",
    });
    mockUseNavigation.mockReturnValue({
      state: "idle",
    } as ReturnType<typeof useNavigation>);

    render(<MfaChallengeRoute />);

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("mfa.challenge.error_invalid")).toBeTruthy();
  });

  it("disables submit and inputs while submitting", async () => {
    const MfaChallengeRoute = (await import("./challenge.js")).default;
    mockUseActionData.mockReturnValue(undefined);
    mockUseNavigation.mockReturnValue({
      state: "submitting",
    } as ReturnType<typeof useNavigation>);

    render(<MfaChallengeRoute />);

    const submitButton = screen.getByRole("button", {
      name: "mfa.challenge.submit_loading",
    });
    expect(submitButton).toHaveProperty("disabled", true);
  });
});

describe("TotpInput — component", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders exactly 6 single-character inputs", async () => {
    const { TotpInput } = await import("../../../components/TotpInput.js");
    const onChange = vi.fn();
    render(<TotpInput value="" onChange={onChange} />);

    const inputs = screen
      .getAllByRole("textbox")
      .filter((el) => (el as HTMLInputElement).maxLength === 1);
    expect(inputs).toHaveLength(6);
  });

  it("calls onChange with digit when a character is typed", async () => {
    const { TotpInput } = await import("../../../components/TotpInput.js");
    const onChange = vi.fn();
    render(<TotpInput value="" onChange={onChange} />);

    const inputs = screen
      .getAllByRole("textbox")
      .filter((el) => (el as HTMLInputElement).maxLength === 1);

    const first = inputs[0];
    if (!first) throw new Error("No inputs found");
    fireEvent.change(first, { target: { value: "4" } });
    expect(onChange).toHaveBeenCalledWith("4");
  });

  it("ignores non-digit characters", async () => {
    const { TotpInput } = await import("../../../components/TotpInput.js");
    const onChange = vi.fn();
    render(<TotpInput value="" onChange={onChange} />);

    const inputs = screen
      .getAllByRole("textbox")
      .filter((el) => (el as HTMLInputElement).maxLength === 1);

    const first = inputs[0];
    if (!first) throw new Error("No inputs found");
    fireEvent.change(first, { target: { value: "a" } });
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("all inputs are disabled when disabled prop is true", async () => {
    const { TotpInput } = await import("../../../components/TotpInput.js");
    render(<TotpInput value="" onChange={vi.fn()} disabled />);

    const inputs = screen
      .getAllByRole("textbox")
      .filter((el) => (el as HTMLInputElement).maxLength === 1);

    inputs.forEach((input) => {
      expect(input).toHaveProperty("disabled", true);
    });
  });
});
