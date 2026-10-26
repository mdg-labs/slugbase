import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RowActions, type RowAction } from "../../src/patterns/index.ts";
import { expectNoViolations, stubBrowserApis, stubMatchMedia } from "../support.tsx";

function actionsOf(onSelect: () => void): readonly RowAction[] {
  return [
    { id: "role", label: "Change role", onSelect },
    { id: "remove", label: "Remove", destructive: true, onSelect: () => undefined },
    { id: "locked", label: "Transfer ownership", disabled: true, onSelect: () => undefined },
  ];
}

async function open(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Actions for Ada" }));
    await Promise.resolve();
  });
}

beforeEach(() => {
  stubBrowserApis();
  stubMatchMedia(false);
});

afterEach(() => {
  stubMatchMedia(false);
});

describe("RowActions", () => {
  it("is an icon button named for the row, with no menu until it is pressed", () => {
    render(<RowActions actions={actionsOf(() => undefined)} label="Actions for Ada" />);

    expect(screen.getByRole("button", { name: "Actions for Ada" })).toBeTruthy();
    expect(screen.queryByRole("menuitem")).toBeNull();
  });

  it("opens a menu listing the actions, the unavailable one disabled", async () => {
    render(<RowActions actions={actionsOf(() => undefined)} label="Actions for Ada" />);

    await open();
    const items = await screen.findAllByRole("menuitem");

    expect(items.map((item) => item.textContent)).toEqual(["Change role", "Remove", "Transfer ownership"]);
    expect(items[2]?.getAttribute("aria-disabled")).toBe("true");
  });

  it("runs the chosen action", async () => {
    const onSelect = vi.fn<() => void>();
    render(<RowActions actions={actionsOf(onSelect)} label="Actions for Ada" />);

    await open();
    const items = await screen.findAllByRole("menuitem");
    await act(async () => {
      fireEvent.click(items[0] as HTMLElement);
      await Promise.resolve();
    });

    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("is free of accessibility violations while closed", async () => {
    const { container } = render(<RowActions actions={actionsOf(() => undefined)} label="Actions for Ada" />);

    await expectNoViolations(container);
  });

  it("is free of accessibility violations while open", async () => {
    render(<RowActions actions={actionsOf(() => undefined)} label="Actions for Ada" />);

    await open();
    await screen.findAllByRole("menuitem");
    await expectNoViolations(document.body);
  });

  it("shows no button for a row without actions", () => {
    render(<RowActions actions={[]} label="Actions for Ada" />);

    expect(screen.queryByRole("button")).toBeNull();
  });

  it("becomes a bottom drawer on a narrow screen, closes it and runs the chosen action", async () => {
    stubMatchMedia(true);
    const onSelect = vi.fn<() => void>();
    render(<RowActions actions={actionsOf(onSelect)} label="Actions for Ada" />);

    await open();
    const dialog = await screen.findByRole("dialog", { name: "Actions for Ada" });
    expect(screen.queryByRole("menuitem")).toBeNull();
    expect(within(dialog).getAllByRole("button").map((button) => button.textContent)).toEqual(["Change role", "Remove", "Transfer ownership"]);
    await expectNoViolations(document.body);
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Change role" }));
      await Promise.resolve();
    });

    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
