import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IconPicker } from "./IconPicker.js";

const labels = {
  searchPlaceholder: "Search icons…",
  noResults: "No icons match your search",
  clear: "Remove icon",
};

describe("IconPicker", () => {
  afterEach(() => {
    cleanup();
  });
  it("filters icons by search query and selects an icon", () => {
    const onChange = vi.fn();

    render(<IconPicker value={null} onChange={onChange} labels={labels} />);

    expect(screen.getByTestId("icon-picker-option-palette")).toBeTruthy();
    expect(screen.queryByTestId("icon-picker-option-folder")).toBeTruthy();

    fireEvent.change(screen.getByTestId("icon-picker-search"), {
      target: { value: "palette" },
    });

    expect(screen.getByTestId("icon-picker-option-palette")).toBeTruthy();
    expect(screen.queryByTestId("icon-picker-option-folder")).toBeNull();

    fireEvent.click(screen.getByTestId("icon-picker-option-palette"));
    expect(onChange).toHaveBeenCalledWith("palette");
  });

  it("shows no-results message when search matches nothing", () => {
    render(<IconPicker value={null} onChange={vi.fn()} labels={labels} />);

    fireEvent.change(screen.getByTestId("icon-picker-search"), {
      target: { value: "xyzzy404" },
    });

    expect(screen.getByTestId("icon-picker-no-results").textContent).toBe(labels.noResults);
    expect(screen.queryByTestId("icon-picker-grid")).toBeNull();
  });

  it("clears the selected icon", () => {
    const onChange = vi.fn();

    render(<IconPicker value="palette" onChange={onChange} labels={labels} />);

    fireEvent.click(screen.getByTestId("icon-picker-clear"));
    expect(onChange).toHaveBeenCalledWith(null);
  });
});
