import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SettingSwitch } from "../../src/patterns/index.ts";
import { expectNoViolations } from "../support.tsx";

describe("SettingSwitch", () => {
  it("is a switch named by its label, described, and on or off by its value", async () => {
    const { container } = render(
      <SettingSwitch checked description="Press a letter to act." label="Single-key shortcuts" onCheckedChange={() => undefined} />,
    );

    const toggle = screen.getByRole("switch", { name: "Single-key shortcuts" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(toggle.getAttribute("aria-describedby")).toBeTruthy();
    await expectNoViolations(container);
  });

  it("reports the new value when the switch or its label is clicked", () => {
    const onCheckedChange = vi.fn<(checked: boolean) => void>();
    render(<SettingSwitch checked={false} label="Opt out of AI" onCheckedChange={onCheckedChange} />);

    fireEvent.click(screen.getByRole("switch", { name: "Opt out of AI" }));
    fireEvent.click(screen.getByText("Opt out of AI"));

    expect(onCheckedChange).toHaveBeenCalledTimes(2);
    expect(onCheckedChange).toHaveBeenNthCalledWith(1, true);
  });

  it("marks the switch invalid and describes it by the error", async () => {
    const { container } = render(<SettingSwitch checked error="Not saved." label="Opt out of AI" onCheckedChange={() => undefined} />);

    const toggle = screen.getByRole("switch", { name: "Opt out of AI" });
    expect(toggle.getAttribute("aria-invalid")).toBe("true");
    expect(toggle.getAttribute("aria-describedby")?.split(" ")).toContain(screen.getByText("Not saved.").id);
    await expectNoViolations(container);
  });

  it("reports nothing while disabled", () => {
    const onCheckedChange = vi.fn<(checked: boolean) => void>();
    render(<SettingSwitch checked disabled label="Opt out of AI" onCheckedChange={onCheckedChange} />);

    fireEvent.click(screen.getByRole("switch", { name: "Opt out of AI" }));

    expect(onCheckedChange).not.toHaveBeenCalled();
  });
});
