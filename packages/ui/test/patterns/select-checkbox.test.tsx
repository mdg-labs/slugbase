import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SelectCheckbox } from "../../src/patterns/index.ts";
import { expectNoViolations } from "../support.tsx";

describe("SelectCheckbox", () => {
  it("is a checkbox named by its label that reports the new state when it is pressed", async () => {
    const onCheckedChange = vi.fn();
    const { container } = render(<SelectCheckbox checked={false} label="Select Example" onCheckedChange={onCheckedChange} />);

    const checkbox = screen.getByRole("checkbox", { name: "Select Example" });
    expect(checkbox.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(checkbox);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
    await expectNoViolations(container);
  });

  it("shows the state it is given", () => {
    render(<SelectCheckbox checked label="Select Example" />);

    expect(screen.getByRole("checkbox", { name: "Select Example" }).getAttribute("aria-checked")).toBe("true");
  });
});
