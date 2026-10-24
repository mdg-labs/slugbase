import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BulkBar } from "../../src/patterns/index.ts";
import { expectNoViolations } from "../support.tsx";

function renderBar(props: { busy?: boolean; onPin?: () => void; onDelete?: () => void; onClear?: () => void; loading?: "pin" | "delete" } = {}) {
  return render(
    <BulkBar
      actions={[
        { id: "pin", label: "Pin", loading: props.loading === "pin", onSelect: props.onPin ?? (() => undefined) },
        { id: "delete", label: "Delete", destructive: true, loading: props.loading === "delete", onSelect: props.onDelete ?? (() => undefined) },
      ]}
      busy={props.busy ?? false}
      clear={{ label: "Clear selection", onClear: props.onClear ?? (() => undefined) }}
      count="14 selected"
      label="Selected bookmarks"
    >
      <span>Select all 120 matching</span>
    </BulkBar>,
  );
}

describe("BulkBar", () => {
  it("is a toolbar named by its label with the count, what is said beside it, the actions and a way to clear", async () => {
    const onPin = vi.fn();
    const onClear = vi.fn();
    const { container } = renderBar({ onPin, onClear });

    const bar = screen.getByRole("toolbar", { name: "Selected bookmarks" });
    expect(within(bar).getByText("14 selected")).toBeTruthy();
    expect(within(bar).getByText("Select all 120 matching")).toBeTruthy();
    fireEvent.click(within(bar).getByRole("button", { name: "Pin" }));
    fireEvent.click(within(bar).getByRole("button", { name: "Clear selection" }));
    expect(onPin).toHaveBeenCalledTimes(1);
    expect(onClear).toHaveBeenCalledTimes(1);
    await expectNoViolations(container);
  });

  it("moves focus between its buttons with the arrow keys, as a toolbar does", async () => {
    renderBar();
    const pin = screen.getByRole("button", { name: "Pin" });
    pin.focus();

    fireEvent.keyDown(pin, { key: "ArrowRight" });
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Delete" }));
    });
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowRight" });
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Clear selection" }));
    });
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowLeft" });
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Delete" }));
    });
  });

  it("keeps every other action and the clear button from being pressed while one action runs", () => {
    const onPin = vi.fn();
    const onDelete = vi.fn();
    const onClear = vi.fn();
    renderBar({ busy: true, loading: "delete", onPin, onDelete, onClear });

    expect(screen.getByRole("toolbar", { name: "Selected bookmarks" }).getAttribute("aria-busy")).toBe("true");
    for (const name of ["Pin", "Clear selection"]) {
      const button = screen.getByRole("button", { name });
      expect(button.hasAttribute("disabled") || button.getAttribute("aria-disabled") === "true").toBe(true);
      fireEvent.click(button);
    }
    expect(onPin).not.toHaveBeenCalled();
    expect(onClear).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Delete" }).getAttribute("data-loading")).not.toBeNull();
  });
});
