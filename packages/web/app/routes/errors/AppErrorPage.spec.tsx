import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tolgee/react", () => ({
  useTranslate: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("react-router", async (importOriginal) => {
  const original = await importOriginal<typeof import("react-router")>();
  return {
    ...original,
    Link: ({
      children,
      to,
      ...props
    }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
      to: string;
      children: React.ReactNode;
    }) => (
      <a href={to} {...props}>
        {children}
      </a>
    ),
    useLocation: () => ({
      pathname: "/missing-page",
      search: "",
      hash: "",
      state: null,
      key: "test",
    }),
  };
});

vi.mock("../../components/consent/consent-storage.js", () => ({
  isAnalyticsConsentGranted: vi.fn(() => true),
}));

vi.mock("../../lib/error-reporting-client.js", () => ({
  captureClientException: vi.fn(),
}));

import { AppErrorPage } from "./AppErrorPage.js";

describe("AppErrorPage", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders 404 with path and primary action", () => {
    render(<AppErrorPage status={404} />);

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "error.page.404.title",
    );
    expect(screen.getByText("error.page.404.description")).not.toBeNull();
    expect(screen.getByText("/missing-page")).not.toBeNull();
    expect(screen.getByRole("link", { name: "error.page.action.bookmarks" }).getAttribute("href")).toBe(
      "/bookmarks",
    );
  });

  it("renders 403 without path flavor", () => {
    render(<AppErrorPage status={403} />);

    expect(screen.getByText("error.page.403.title")).not.toBeNull();
    expect(screen.queryByText("/missing-page")).toBeNull();
    expect(screen.getByRole("link", { name: "error.page.action.workspace" }).getAttribute("href")).toBe(
      "/",
    );
  });

  it("renders 500 with reload action", () => {
    render(<AppErrorPage status={500} />);

    expect(screen.getByText("error.page.500.title")).not.toBeNull();
    expect(screen.getByRole("button", { name: "error.page.action.reload" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "error.page.action.back" })).toBeNull();
  });

  it("reports error when report button is clicked", () => {
    render(<AppErrorPage status={500} error={new Error("boom")} />);

    fireEvent.click(screen.getByRole("button", { name: "error.page.report" }));
    expect(screen.getByRole("button", { name: "error.page.report_done" })).not.toBeNull();
  });
});
