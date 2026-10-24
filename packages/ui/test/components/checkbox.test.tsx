import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Checkbox } from "../../src/index.ts";
import { expectNoViolations } from "../support.tsx";

describe("Checkbox", () => {
  it("is a checkbox named by its label that reports each change", async () => {
    const onCheckedChange = vi.fn<(checked: boolean) => void>();
    const { container } = render(<Checkbox aria-label="Select Example" checked={false} onCheckedChange={onCheckedChange} />);
    const checkbox = screen.getByRole("checkbox", { name: "Select Example" });

    expect(checkbox.getAttribute("aria-checked")).toBe("false");
    expect(checkbox.getAttribute("data-slot")).toBe("checkbox");
    await expectNoViolations(container);

    fireEvent.click(checkbox);

    expect(onCheckedChange).toHaveBeenCalledTimes(1);
    expect(onCheckedChange.mock.calls[0]?.[0]).toBe(true);
  });
});
