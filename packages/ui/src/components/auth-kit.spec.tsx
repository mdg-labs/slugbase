import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AuthHeading, AuthShell, ErrorBanner } from "./auth-kit.js";

describe("AuthShell", () => {
  it("renders brand copy and form children", () => {
    render(
      <AuthShell
        brand={{
          headline: "Headline",
          subline: "Subline",
          footer: "Footer",
        }}
        showSlugRows={false}
      >
        <AuthHeading title="Sign in" />
        <ErrorBanner message="Invalid credentials" />
      </AuthShell>,
    );

    expect(screen.getByRole("heading", { name: "Sign in" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Invalid credentials");
  });
});
