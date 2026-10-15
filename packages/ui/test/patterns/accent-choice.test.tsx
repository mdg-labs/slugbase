import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ACCENTS, type Accent } from "../../src/index.ts";
import { AccentChoice } from "../../src/patterns/index.ts";
import { expectNoViolations } from "../support.tsx";

const NAMES: Record<Accent, string> = {
  periwinkle: "Periwinkle",
  violet: "Violet",
  rose: "Rose",
  amber: "Amber",
  green: "Green",
  teal: "Teal",
};

describe("AccentChoice", () => {
  it("offers the six presets as named radios, each painted with its own preset, and checks the current one", async () => {
    const { container } = render(<AccentChoice label="Accent colour" names={NAMES} onValueChange={() => undefined} value="rose" />);

    expect(screen.getByRole("radiogroup", { name: "Accent colour" })).toBeTruthy();
    const radios = screen.getAllByRole("radio");
    expect(radios.map((radio) => radio.getAttribute("aria-label"))).toEqual(ACCENTS.map((accent) => NAMES[accent]));
    expect(radios.map((radio) => radio.getAttribute("data-accent"))).toEqual([...ACCENTS]);
    expect(screen.getByRole("radio", { name: "Rose" }).getAttribute("aria-checked")).toBe("true");
    expect(radios.filter((radio) => radio.getAttribute("aria-checked") === "true")).toHaveLength(1);
    await expectNoViolations(container);
  });

  it("shows a check mark in the chosen swatch, so the choice is not by colour alone", () => {
    render(<AccentChoice label="Accent colour" names={NAMES} onValueChange={() => undefined} value="teal" />);
    expect(screen.getByRole("radio", { name: "Teal" }).querySelector("svg")).not.toBeNull();
    expect(screen.getByRole("radio", { name: "Rose" }).querySelector("svg")).toBeNull();
  });

  it("reports the preset the member chooses", () => {
    const onValueChange = vi.fn<(value: Accent) => void>();
    render(<AccentChoice label="Accent colour" names={NAMES} onValueChange={onValueChange} value="periwinkle" />);

    fireEvent.click(screen.getByRole("radio", { name: "Green" }));

    expect(onValueChange).toHaveBeenCalledExactlyOnceWith("green");
  });
});
