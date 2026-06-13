import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { staticMessages } from "../i18n/messages.js";

vi.mock("../i18n/use-app-locale.js", () => ({
  useAppLocale: () => "en" as const,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const messages = staticMessages.en as Record<string, string>;
      return messages[key] ?? key;
    },
  }),
}));

import { LegalLinks } from "./LegalLinks.js";

describe("LegalLinks", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
  });

  it("renders nothing when VITE_MARKETING_ORIGIN is unset", () => {
    vi.stubEnv("VITE_MARKETING_ORIGIN", "");
    render(<LegalLinks />);
    expect(screen.queryByTestId("legal-links")).toBeNull();
  });

  it("renders impressum, privacy, and terms when marketing origin is set", () => {
    vi.stubEnv("VITE_MARKETING_ORIGIN", "https://marketing.example.com");

    render(<LegalLinks />);

    expect(screen.getByTestId("legal-links")).toBeTruthy();
    expect(screen.getByTestId("legal-link-impressum").getAttribute("href")).toBe(
      "https://marketing.example.com/legal/impressum",
    );
    expect(screen.getByTestId("legal-link-datenschutz").getAttribute("href")).toBe(
      "https://marketing.example.com/legal/datenschutz",
    );
    expect(screen.getByTestId("legal-link-agb").getAttribute("href")).toBe(
      "https://marketing.example.com/legal/agb",
    );
    expect(screen.getByTestId("legal-link-impressum").getAttribute("target")).toBe("_blank");
    expect(screen.getByTestId("legal-link-impressum").getAttribute("rel")).toBe(
      "noopener noreferrer",
    );
    expect(screen.getByText("Impressum")).toBeTruthy();
    expect(screen.getByText("Privacy")).toBeTruthy();
    expect(screen.getByText("Terms")).toBeTruthy();
  });
});
