import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SegmentedChoice } from "../../src/patterns/index.ts";
import { expectNoViolations } from "../support.tsx";

const THEMES = [
  { value: "system", label: "System" },
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
];

describe("SegmentedChoice", () => {
  it("is a radio group named by its label with the chosen option checked, and described", async () => {
    const { container } = render(
      <SegmentedChoice description="System follows your device." label="Theme" onValueChange={() => undefined} options={THEMES} value="dark" />,
    );

    const group = screen.getByRole("radiogroup", { name: "Theme" });
    expect(group.getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Dark" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "System" }).getAttribute("aria-checked")).toBe("false");
    await expectNoViolations(container);
  });

  it("reports the option the member chooses", () => {
    const onValueChange = vi.fn<(value: string) => void>();
    render(<SegmentedChoice label="Theme" onValueChange={onValueChange} options={THEMES} value="system" />);

    fireEvent.click(screen.getByRole("radio", { name: "Light" }));

    expect(onValueChange).toHaveBeenCalledExactlyOnceWith("light");
  });

  it("marks the group invalid and describes it by the error", async () => {
    const { container } = render(<SegmentedChoice error="Choose a theme." label="Theme" onValueChange={() => undefined} options={THEMES} value="dark" />);

    const group = screen.getByRole("radiogroup", { name: "Theme" });
    expect(group.getAttribute("aria-invalid")).toBe("true");
    expect(group.getAttribute("aria-describedby")?.split(" ")).toContain(screen.getByText("Choose a theme.").id);
    await expectNoViolations(container);
  });

  it("reports nothing while disabled", () => {
    const onValueChange = vi.fn<(value: string) => void>();
    render(<SegmentedChoice disabled label="Theme" onValueChange={onValueChange} options={THEMES} value="system" />);

    fireEvent.click(screen.getByRole("radio", { name: "Light" }));

    expect(onValueChange).not.toHaveBeenCalled();
  });
});
