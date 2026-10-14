import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AuthCard } from "../../src/patterns/index.ts";
import { expectNoViolations } from "../support.tsx";

function Card(): React.ReactElement {
  return (
    <AuthCard description="Welcome back." footer={<span>Footer text</span>} productName="SlugBase" title="Sign in">
      <p>Card content</p>
    </AuthCard>
  );
}

describe("AuthCard", () => {
  it("names the main region by its heading and shows the product name, content and footer", () => {
    render(<Card />);

    expect(screen.getByRole("main")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Sign in" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Sign in" })).toBeTruthy();
    expect(screen.getByText("SlugBase")).toBeTruthy();
    expect(screen.getByText("Welcome back.")).toBeTruthy();
    expect(screen.getByText("Card content")).toBeTruthy();
    expect(screen.getByText("Footer text")).toBeTruthy();
  });

  it("has no footer element when it is given none", () => {
    const { container } = render(
      <AuthCard productName="SlugBase" title="Sign in">
        <p>Card content</p>
      </AuthCard>,
    );

    expect(container.querySelector("[data-slot='auth-card-footer']")).toBeNull();
  });

  it("is free of accessibility violations in both themes", async () => {
    for (const dark of [false, true]) {
      document.documentElement.classList.toggle("dark", dark);
      const { container, unmount } = render(<Card />);
      await expectNoViolations(container);
      unmount();
    }
  });
});
