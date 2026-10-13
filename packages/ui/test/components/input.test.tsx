import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Input } from "../../src/index.ts";
import { expectNoViolations } from "../support.tsx";

describe("Input", () => {
  it("renders a labelled text box that reports typing", async () => {
    const onChange = vi.fn();
    const { container } = render(<Input aria-label="Search" onChange={onChange} placeholder="Search bookmarks" />);

    const box = screen.getByRole<HTMLInputElement>("textbox", { name: "Search" });
    fireEvent.change(box, { target: { value: "docs" } });

    expect(box.value).toBe("docs");
    expect(onChange).toHaveBeenCalledTimes(1);
    await expectNoViolations(container);
  });

  it("marks a disabled input as disabled", () => {
    render(<Input aria-label="Slug" disabled />);

    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Slug" }).disabled).toBe(true);
  });
});
