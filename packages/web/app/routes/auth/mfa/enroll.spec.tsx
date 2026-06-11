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
    useLoaderData: vi.fn(() => ({
      otpAuthUri: "otpauth://totp/SlugBase:test?secret=ABCDEF&issuer=SlugBase",
      textSecret: "ABCDEF",
      qrDataUri: "data:image/png;base64,abc",
    })),
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("../../../lib/session-client.js", () => ({
  getSessionUser: vi.fn(),
}));

import { useActionData, useLoaderData, useNavigation } from "react-router";

const mockUseActionData = vi.mocked(useActionData);
const mockUseNavigation = vi.mocked(useNavigation);
const mockUseLoaderData = vi.mocked(useLoaderData);

const SAMPLE_BACKUP_CODES = [
  "aaaa-bbbb",
  "cccc-dddd",
  "eeee-ffff",
  "gggg-hhhh",
  "iiii-jjjj",
  "kkkk-llll",
  "mmmm-nnnn",
  "oooo-pppp",
];

describe("MFA enroll route - shouldRevalidate", () => {
  it("returns false so enrol/start is not re-run after confirm", async () => {
    const { shouldRevalidate } = await import("./enroll.js");
    expect(shouldRevalidate()).toBe(false);
  });
});

describe("MFA enroll route - action", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ backupCodes: SAMPLE_BACKUP_CODES }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    process.env["API_BASE_URL"] = "http://localhost:3000";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env["API_BASE_URL"];
  });

  it("returns error key for empty or short TOTP code", async () => {
    const { action } = await import("./enroll.js");
    const formData = new FormData();
    formData.set("totpCode", "123");
    const request = new Request("http://localhost/mfa/enroll", {
      method: "POST",
      body: formData,
    });
    const args = {
      request,
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs;
    const result = await action(args);
    expect(result).toEqual({ error: "mfa.enroll.error_invalid" });
  });

  it("returns backup codes on successful confirm", async () => {
    const { action } = await import("./enroll.js");
    const formData = new FormData();
    formData.set("totpCode", "123456");
    const request = new Request("http://localhost/mfa/enroll", {
      method: "POST",
      body: formData,
    });
    const args = {
      request,
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs;
    const result = await action(args);
    expect(result).toEqual({ backupCodes: SAMPLE_BACKUP_CODES });
  });

  it("returns error_invalid on 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: "Invalid" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const { action } = await import("./enroll.js");
    const formData = new FormData();
    formData.set("totpCode", "000000");
    const request = new Request("http://localhost/mfa/enroll", {
      method: "POST",
      body: formData,
    });
    const args = {
      request,
      params: {},
      context: {},
    } as unknown as ActionFunctionArgs;
    const result = await action(args);
    expect(result).toEqual({ error: "mfa.enroll.error_invalid" });
  });
});

describe("MFA enroll route - enroll confirm step", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders QR enroll step when action has no backup codes", async () => {
    const MfaEnrollRoute = (await import("./enroll.js")).default;
    mockUseActionData.mockReturnValue(undefined);
    mockUseNavigation.mockReturnValue({
      state: "idle",
    } as ReturnType<typeof useNavigation>);
    mockUseLoaderData.mockReturnValue({
      otpAuthUri: "otpauth://totp/SlugBase:test?secret=ABCDEF&issuer=SlugBase",
      textSecret: "ABCDEF",
      qrDataUri: "data:image/png;base64,abc",
    });

    render(<MfaEnrollRoute />);

    expect(screen.getByText("mfa.enroll.title")).toBeTruthy();
    expect(screen.getByAltText("mfa.enroll.qr_alt")).toBeTruthy();
    expect(screen.queryByText("mfa.backup_codes.title")).toBeNull();
  });
});

describe("MFA enroll route - backup codes step (shown once)", () => {
  const writeText = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    writeText.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders backup codes step instead of enroll form after confirm", async () => {
    const MfaEnrollRoute = (await import("./enroll.js")).default;
    mockUseActionData.mockReturnValue({ backupCodes: SAMPLE_BACKUP_CODES });
    mockUseNavigation.mockReturnValue({
      state: "idle",
    } as ReturnType<typeof useNavigation>);
    mockUseLoaderData.mockReturnValue({
      otpAuthUri: "otpauth://totp/SlugBase:test?secret=ABCDEF&issuer=SlugBase",
      textSecret: "ABCDEF",
      qrDataUri: "data:image/png;base64,abc",
    });

    render(<MfaEnrollRoute />);

    expect(screen.getByText("mfa.backup_codes.title")).toBeTruthy();
    expect(screen.getByText("mfa.backup_codes.warning")).toBeTruthy();
    expect(screen.queryByText("mfa.enroll.title")).toBeNull();
    expect(screen.queryByAltText("mfa.enroll.qr_alt")).toBeNull();

    for (const code of SAMPLE_BACKUP_CODES) {
      expect(screen.getByText(code)).toBeTruthy();
    }
  });

  it("gates continue link until confirmation checkbox is checked", async () => {
    const MfaEnrollRoute = (await import("./enroll.js")).default;
    mockUseActionData.mockReturnValue({ backupCodes: SAMPLE_BACKUP_CODES });
    mockUseNavigation.mockReturnValue({
      state: "idle",
    } as ReturnType<typeof useNavigation>);
    mockUseLoaderData.mockReturnValue({
      otpAuthUri: "otpauth://totp/SlugBase:test?secret=ABCDEF&issuer=SlugBase",
      textSecret: "ABCDEF",
      qrDataUri: "data:image/png;base64,abc",
    });

    render(<MfaEnrollRoute />);

    const continueLink = screen.getByRole("link", {
      name: "mfa.backup_codes.submit",
    });
    expect(continueLink.getAttribute("aria-disabled")).toBe("true");

    fireEvent.click(screen.getByRole("checkbox"));

    await waitFor(() => {
      expect(continueLink.getAttribute("aria-disabled")).toBe("false");
    });
  });

  it("copy button writes all codes to clipboard and shows copied label", async () => {
    const MfaEnrollRoute = (await import("./enroll.js")).default;
    mockUseActionData.mockReturnValue({ backupCodes: SAMPLE_BACKUP_CODES });
    mockUseNavigation.mockReturnValue({
      state: "idle",
    } as ReturnType<typeof useNavigation>);
    mockUseLoaderData.mockReturnValue({
      otpAuthUri: "otpauth://totp/SlugBase:test?secret=ABCDEF&issuer=SlugBase",
      textSecret: "ABCDEF",
      qrDataUri: "data:image/png;base64,abc",
    });

    render(<MfaEnrollRoute />);

    const copyButton = screen.getByRole("button", {
      name: "mfa.backup_codes.copy",
    });
    fireEvent.click(copyButton);

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(SAMPLE_BACKUP_CODES.join("\n"));
      expect(screen.getByRole("button", { name: "mfa.backup_codes.copied" })).toBeTruthy();
    });
  });
});
