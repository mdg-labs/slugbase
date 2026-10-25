import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UsageMeter } from "../../src/patterns/index.ts";
import { expectNoViolations } from "../support.tsx";

describe("UsageMeter", () => {
  it("is a progress bar named by its label that reads out the formatted amount against the whole", () => {
    render(<UsageMeter label="reading" max={20} value={5} valueLabel="5 bookmarks" />);

    const bar = screen.getByRole("progressbar", { name: "reading" });
    expect(bar.getAttribute("aria-valuenow")).toBe("5");
    expect(bar.getAttribute("aria-valuemax")).toBe("20");
    expect(bar.getAttribute("aria-valuetext")).toBe("5 bookmarks");
    expect(bar.textContent).toContain("5 bookmarks");
  });

  it("fills the bar to the share of the whole", () => {
    const { container } = render(<UsageMeter label="reading" max={20} value={5} valueLabel="5 bookmarks" />);

    const indicator = container.querySelector<HTMLElement>("[data-slot=progress-indicator]");
    expect(indicator?.style.width).toBe("25%");
  });

  it("never fills past the whole", () => {
    const { container } = render(<UsageMeter label="reading" max={20} value={30} valueLabel="30 bookmarks" />);

    expect(container.querySelector<HTMLElement>("[data-slot=progress-indicator]")?.style.width).toBe("100%");
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("20");
  });

  it("is free of accessibility violations in both themes", async () => {
    for (const dark of [false, true]) {
      document.documentElement.classList.toggle("dark", dark);
      const { container, unmount } = render(<UsageMeter label="reading" max={20} value={5} valueLabel="5 bookmarks" />);
      await expectNoViolations(container);
      unmount();
    }
  });
});
