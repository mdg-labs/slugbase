import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusBadge } from "../../src/patterns/index.ts";
import { expectNoViolations } from "../support.tsx";

describe("StatusBadge", () => {
  it("names the state in words, whatever its colour", async () => {
    const { container } = render(
      <div>
        {(["neutral", "info", "success", "warning", "error"] as const).map((variant) => (
          <StatusBadge key={variant} variant={variant}>
            {`State ${variant}`}
          </StatusBadge>
        ))}
      </div>,
    );

    expect(screen.getAllByText(/^State /)).toHaveLength(5);
    await expectNoViolations(container);
  });

  it("takes the colour of its variant", () => {
    render(<StatusBadge variant="error">Disabled</StatusBadge>);

    expect(screen.getByText("Disabled").className).toContain("text-destructive-foreground");
  });
});
