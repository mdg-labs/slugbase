import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TextareaField } from "../../src/patterns/index.ts";
import { expectNoViolations } from "../support.tsx";

describe("TextareaField", () => {
  it("is a textarea named by its label, capped at the maximum, and described by the counter", () => {
    render(<TextareaField counter="4 / 10" label="Description" maxLength={10} onChange={() => undefined} value="abcd" />);

    const field = screen.getByRole("textbox", { name: "Description" });
    expect(field.getAttribute("maxlength")).toBe("10");
    expect(field.getAttribute("aria-describedby")?.split(" ")).toContain(screen.getByText("4 / 10").closest("[id]")?.id);
  });

  it("is free of accessibility violations", async () => {
    const { container } = render(<TextareaField counter="4 / 10" label="Description" maxLength={10} onChange={() => undefined} value="abcd" />);

    await expectNoViolations(container);
  });

  it("reports what is typed", () => {
    const onChange = vi.fn<(value: string) => void>();
    render(<TextareaField counter="0 / 10" label="Description" maxLength={10} onChange={onChange} value="" />);

    fireEvent.change(screen.getByRole("textbox", { name: "Description" }), { target: { value: "hello" } });

    expect(onChange).toHaveBeenCalledWith("hello");
  });

  it("marks the field invalid and describes it by the error", () => {
    render(<TextareaField counter="0 / 10" error="Too long." label="Description" maxLength={10} onChange={() => undefined} value="" />);

    const field = screen.getByRole("textbox", { name: "Description" });
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(field.getAttribute("aria-describedby")?.split(" ")).toContain(screen.getByText("Too long.").id);
  });
});
