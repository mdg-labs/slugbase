import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Switch } from "../../src/index.ts";
import { expectNoViolations } from "../support.tsx";

describe("Switch", () => {
  it("is a named switch that reports its state and takes a click", async () => {
    const onCheckedChange = vi.fn<(checked: boolean) => void>();
    const { container } = render(<Switch aria-label="Forwarding" checked={false} onCheckedChange={onCheckedChange} />);
    const control = screen.getByRole("switch", { name: "Forwarding" });

    expect(control.getAttribute("aria-checked")).toBe("false");
    expect(control.getAttribute("data-slot")).toBe("switch");
    await expectNoViolations(container);

    fireEvent.click(control);

    expect(onCheckedChange).toHaveBeenCalledTimes(1);
    expect(onCheckedChange.mock.calls[0]?.[0]).toBe(true);
  });

  it("does not change while it is disabled", () => {
    const onCheckedChange = vi.fn<(checked: boolean) => void>();
    render(<Switch aria-label="Forwarding" checked disabled onCheckedChange={onCheckedChange} />);

    fireEvent.click(screen.getByRole("switch", { name: "Forwarding" }));

    expect(onCheckedChange).not.toHaveBeenCalled();
  });
});
