import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Loading } from "../../src/patterns/index.ts";
import { expectNoViolations } from "../support.tsx";

describe("Loading", () => {
  it("is a busy status region named by its label, holding skeletons", async () => {
    const { container } = render(<Loading label="Wird geladen" />);

    const status = screen.getByRole("status", { name: "Wird geladen" });
    expect(status.getAttribute("aria-busy")).toBe("true");
    expect(status.querySelectorAll("[data-slot='skeleton']").length).toBeGreaterThan(0);
    await expectNoViolations(container);
  });

  it("shows the skeleton it is given in place of the default", () => {
    render(
      <Loading label="Loading">
        <p>Custom</p>
      </Loading>,
    );

    expect(screen.getByRole("status").textContent).toBe("Custom");
  });
});
