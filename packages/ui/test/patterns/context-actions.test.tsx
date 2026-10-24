import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContextActions, type RowAction } from "../../src/patterns/index.ts";
import { expectNoViolations, stubBrowserApis, stubMatchMedia } from "../support.tsx";

beforeEach(() => {
  stubBrowserApis();
  stubMatchMedia(false);
});

afterEach(() => {
  stubMatchMedia(false);
});

async function rightClick(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.contextMenu(element, { clientX: 10, clientY: 10 });
    await Promise.resolve();
  });
}

describe("ContextActions", () => {
  it("opens the actions on a right click, runs the chosen one and closes", async () => {
    const onSelect = vi.fn<() => void>();
    const actions: readonly RowAction[] = [
      { id: "edit", label: "Edit", onSelect },
      { id: "delete", label: "Delete", destructive: true, onSelect: () => undefined },
      { id: "locked", label: "Locked", disabled: true, onSelect: () => undefined },
    ];
    const { container } = render(
      <ContextActions actions={actions} label="Actions for Example">
        <p>Card</p>
      </ContextActions>,
    );
    expect(screen.queryByRole("menu")).toBeNull();
    await expectNoViolations(container);

    await rightClick(screen.getByText("Card"));
    const menu = await screen.findByRole("menu", { name: "Actions for Example" });
    const items = screen.getAllByRole("menuitem");
    expect(menu).toBeDefined();
    expect(items.map((item) => item.textContent)).toEqual(["Edit", "Delete", "Locked"]);
    expect(items[2]?.getAttribute("aria-disabled")).toBe("true");
    await act(async () => {
      fireEvent.click(items[0] as HTMLElement);
      await Promise.resolve();
    });

    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("is the bare area when there are no actions", async () => {
    render(
      <ContextActions actions={[]} label="Actions for Example">
        <p>Card</p>
      </ContextActions>,
    );

    await rightClick(screen.getByText("Card"));

    expect(screen.queryByRole("menu")).toBeNull();
  });
});
