import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AuthCard, AuthLayout } from "../../src/patterns/index.ts";
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

describe("AuthLayout", () => {
  it("holds its content under the product name in the main region, and widens for a wizard", () => {
    const { container, rerender } = render(
      <AuthLayout footer="Footer text" productName="SlugBase">
        <p>Content</p>
      </AuthLayout>,
    );

    expect(screen.getByRole("main").textContent).toContain("SlugBase");
    expect(screen.getByText("Content")).toBeTruthy();
    expect(screen.getByText("Footer text")).toBeTruthy();
    expect(container.querySelector(".max-w-sm")).not.toBeNull();

    rerender(
      <AuthLayout productName="SlugBase" size="md">
        <p>Content</p>
      </AuthLayout>,
    );

    expect(container.querySelector(".max-w-lg")).not.toBeNull();
    expect(container.querySelector(".max-w-sm")).toBeNull();
  });
});
