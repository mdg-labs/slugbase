import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CardGrid, CardGridItem, type RowAction } from "../../src/patterns/index.ts";
import { expectNoViolations, stubBrowserApis, stubMatchMedia } from "../support.tsx";

function actionsOf(onEdit: () => void): readonly RowAction[] {
  return [
    { id: "edit", label: "Edit", onSelect: onEdit },
    { id: "delete", label: "Delete", destructive: true, onSelect: () => undefined },
  ];
}

beforeEach(() => {
  stubBrowserApis();
  stubMatchMedia(false);
});

afterEach(() => {
  stubMatchMedia(false);
});

/** jsdom cannot navigate; a followed link would only log that. */
function stayOnPage(event: MouseEvent): void {
  event.preventDefault();
}

beforeEach(() => {
  document.addEventListener("click", stayOnPage);
});

afterEach(() => {
  document.removeEventListener("click", stayOnPage);
});

function renderCard(props: Partial<Parameters<typeof CardGridItem>[0]> = {}) {
  return render(
    <CardGrid label="Bookmarks">
      <CardGridItem
        actions={actionsOf(() => undefined)}
        actionsLabel="Actions for Example"
        href="https://example.com/docs"
        host="example.com"
        selectLabel="Select Example"
        subtitle="example.com"
        title="Example docs"
        {...props}
      >
        <p>Details</p>
      </CardGridItem>
    </CardGrid>,
  );
}

describe("CardGrid", () => {
  it("lists the cards, with the title as a same-tab link that keeps the opener to itself", () => {
    renderCard();

    const list = screen.getByRole("list", { name: "Bookmarks" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    const link = screen.getByRole("link", { name: "Example docs" });
    expect(link.getAttribute("href")).toBe("https://example.com/docs");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.getAttribute("target")).toBeNull();
    expect(screen.getByRole("heading", { name: "Example docs" })).toBeDefined();
    expect(screen.getByText("example.com").getAttribute("translate")).toBe("no");
    expect(screen.getByText("Details")).toBeDefined();
    expect(screen.getByRole("checkbox", { name: "Select Example" })).toBeDefined();
  });

  it("is free of accessibility violations", async () => {
    const { container } = renderCard();

    await expectNoViolations(container);
  });

  it("reports a click and a middle click on the link, and no other mouse button", () => {
    const onOpen = vi.fn<() => void>();
    renderCard({ onOpen });
    const link = screen.getByRole("link", { name: "Example docs" });

    fireEvent.click(link);
    fireEvent(link, new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    fireEvent(link, new MouseEvent("auxclick", { bubbles: true, button: 2 }));

    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it("shows the title as plain text when the card leads nowhere", () => {
    renderCard({ href: undefined });

    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByRole("heading", { name: "Example docs" })).toBeDefined();
  });

  it("offers the same actions from the menu button and the context menu, and runs them", async () => {
    const onEdit = vi.fn<() => void>();
    renderCard({ actions: actionsOf(onEdit) });

    await act(async () => {
      fireEvent.contextMenu(screen.getByText("Details"), { clientX: 5, clientY: 5 });
      await Promise.resolve();
    });
    const fromContext = (await screen.findAllByRole("menuitem")).map((item) => item.textContent);
    await act(async () => {
      fireEvent.click(screen.getAllByRole("menuitem")[0] as HTMLElement);
      await Promise.resolve();
    });
    expect(onEdit).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Actions for Example" }));
      await Promise.resolve();
    });
    const fromButton = (await screen.findAllByRole("menuitem")).map((item) => item.textContent);

    expect(fromContext).toEqual(["Edit", "Delete"]);
    expect(fromButton).toEqual(fromContext);
  });

  it("reports the checkbox, shows what is selected, and keeps the checkbox in view while anything is selected", () => {
    const onSelectedChange = vi.fn<(selected: boolean) => void>();
    const { container } = renderCard({ itemId: "b1", selected: true, selectionActive: true, onSelectedChange });

    const checkbox = screen.getByRole("checkbox", { name: "Select Example" });
    expect(checkbox.getAttribute("aria-checked")).toBe("true");
    expect(checkbox.className).toContain("opacity-100");
    expect(container.querySelector("[role='listitem']")?.getAttribute("data-item-id")).toBe("b1");
    expect(container.querySelector("[data-selected='true']")).not.toBeNull();
    fireEvent.click(checkbox);
    expect(onSelectedChange).toHaveBeenCalledWith(false);
  });

  it("hides the checkbox of a card that is not selected until it is hovered or focused", () => {
    renderCard({ selected: false, selectionActive: false });

    expect(screen.getByRole("checkbox", { name: "Select Example" }).className).toContain("opacity-0");
  });

  it("is a list while nothing is selected and an ARIA grid of rows and cells while a selection is active", async () => {
    const card = (selectionActive: boolean) => (
      <CardGrid label="Bookmarks" selectionActive={selectionActive}>
        <CardGridItem actions={actionsOf(() => undefined)} actionsLabel="Actions for Example" href="https://example.com/docs" host="example.com" selectLabel="Select Example" title="Example docs" />
      </CardGrid>
    );
    const { container, rerender } = render(card(false));
    expect(screen.queryByRole("grid")).toBeNull();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    await expectNoViolations(container);

    rerender(card(true));

    const grid = screen.getByRole("grid", { name: "Bookmarks" });
    expect(screen.queryByRole("list")).toBeNull();
    expect(within(grid).getAllByRole("row")).toHaveLength(1);
    expect(within(grid).getAllByRole("gridcell")).toHaveLength(1);
    await expectNoViolations(container);
  });

  it("takes one card as the stop on the Tab key and leaves the others to the arrow keys", () => {
    render(
      <CardGrid label="Bookmarks">
        <CardGridItem actions={actionsOf(() => undefined)} actionsLabel="Actions for One" itemId="one" host="one.example" selectLabel="Select One" tabStop title="One" />
        <CardGridItem actions={actionsOf(() => undefined)} actionsLabel="Actions for Two" itemId="two" host="two.example" selectLabel="Select Two" tabStop={false} title="Two" />
        <CardGridItem actions={actionsOf(() => undefined)} actionsLabel="Actions for Three" itemId="three" host="two.example" selectLabel="Select Three" title="Three" />
      </CardGrid>,
    );

    const items = screen.getAllByRole("listitem");
    expect(items.map((item) => item.getAttribute("tabindex"))).toEqual(["0", "-1", null]);
  });
});
