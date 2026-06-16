import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ColorPicker, PRESET_COLORS } from "./ColorPicker.js";

const labels = {
  label: "Color",
  none: "None",
};

describe("ColorPicker", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders 16 swatches in a grid", () => {
    render(<ColorPicker value={null} onChange={vi.fn()} labels={labels} />);

    expect(PRESET_COLORS).toHaveLength(16);
    expect(screen.getByTestId("color-picker-grid").children).toHaveLength(16);
  });

  it("selects a swatch and toggles off when clicked again", () => {
    const onChange = vi.fn();

    render(<ColorPicker value={null} onChange={onChange} labels={labels} />);

    fireEvent.click(screen.getByTestId("color-picker-swatch-7782f7"));
    expect(onChange).toHaveBeenCalledWith("#7782f7");

    cleanup();
    onChange.mockClear();

    render(<ColorPicker value="#7782f7" onChange={onChange} labels={labels} />);
    fireEvent.click(screen.getByTestId("color-picker-swatch-7782f7"));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("clears the selected color", () => {
    const onChange = vi.fn();

    render(<ColorPicker value="#45c98a" onChange={onChange} labels={labels} />);

    fireEvent.click(screen.getByTestId("color-picker-clear"));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("hides clear control when no color is selected", () => {
    render(<ColorPicker value={null} onChange={vi.fn()} labels={labels} />);

    expect(screen.queryByTestId("color-picker-clear")).toBeNull();
  });
});
