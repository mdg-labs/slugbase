import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContextMenu, ContextMenuItem, ContextMenuPopup, ContextMenuSeparator, ContextMenuTrigger } from "../../src/index.ts";
import { expectNoViolations, stubBrowserApis, stubMatchMedia } from "../support.tsx";

beforeEach(() => {
  stubBrowserApis();
  stubMatchMedia(false);
});

afterEach(() => {
  stubMatchMedia(false);
});

describe("ContextMenu", () => {
  it("opens on a right click over its trigger and runs the chosen item", async () => {
    const onClick = vi.fn<() => void>();
    const { container } = render(
      <ContextMenu>
        <ContextMenuTrigger>Area</ContextMenuTrigger>
        <ContextMenuPopup aria-label="Actions for Example">
          <ContextMenuItem onClick={onClick}>Edit</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive">Delete</ContextMenuItem>
        </ContextMenuPopup>
      </ContextMenu>,
    );
    expect(screen.queryByRole("menu")).toBeNull();
    await expectNoViolations(container);

    await act(async () => {
      fireEvent.contextMenu(screen.getByText("Area"), { clientX: 10, clientY: 10 });
      await Promise.resolve();
    });
    const items = await screen.findAllByRole("menuitem");

    expect(screen.getByRole("menu", { name: "Actions for Example" })).toBeDefined();
    expect(items.map((item) => item.textContent)).toEqual(["Edit", "Delete"]);
    expect(items[1]?.getAttribute("data-variant")).toBe("destructive");

    await act(async () => {
      fireEvent.click(items[0] as HTMLElement);
      await Promise.resolve();
    });

    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
