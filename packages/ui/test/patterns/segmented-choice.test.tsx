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

  it("names an icon-only option for assistive technology and the pointer, and reports it when chosen", async () => {
    const onValueChange = vi.fn<(value: string) => void>();
    const options = THEMES.map((option) => ({ ...option, icon: <svg aria-hidden="true" /> }));
    const { container } = render(<SegmentedChoice iconOnly label="Theme" onValueChange={onValueChange} options={options} value="system" />);

    const light = screen.getByRole("radio", { name: "Light" });
    expect(light.getAttribute("title")).toBe("Light");
    expect(light.querySelector(".sr-only")?.textContent).toBe("Light");
    fireEvent.click(light);

    expect(onValueChange).toHaveBeenCalledExactlyOnceWith("light");
    await expectNoViolations(container);
  });

  it("keeps the visible labels and no title when icon-only is not asked for", () => {
    render(<SegmentedChoice label="Theme" onValueChange={() => undefined} options={THEMES} value="system" />);

    expect(screen.getByRole("radio", { name: "Light" }).getAttribute("title")).toBeNull();
    expect(document.querySelector(".sr-only")).toBeNull();
  });
});
