import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Banner } from "../../src/patterns/index.ts";
import { expectNoViolations } from "../support.tsx";

describe("Banner", () => {
  it("shows its title, description and action, and is announced politely", async () => {
    const { container } = render(
      <Banner action={<button type="button">Retry</button>} description="Nothing is saved." title="You are offline" variant="warning" />,
    );

    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("You are offline");
    expect(banner.textContent).toContain("Nothing is saved.");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    await expectNoViolations(container);
  });

  it("is announced as an alert only for an error", async () => {
    const { container } = render(<Banner title="Could not load" variant="error" />);

    expect(screen.getByRole("alert").textContent).toContain("Could not load");
    expect(screen.queryByRole("status")).toBeNull();
    await expectNoViolations(container);
  });

  it.each(["info", "success", "warning", "error"] as const)("is free of accessibility violations as %s in both themes", async (variant) => {
    for (const dark of [false, true]) {
      document.documentElement.classList.toggle("dark", dark);
      const { container, unmount } = render(<Banner description="Detail" title="Title" variant={variant} />);
      await expectNoViolations(container);
      unmount();
    }
  });
});
