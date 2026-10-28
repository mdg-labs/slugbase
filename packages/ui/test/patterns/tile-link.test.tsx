import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TileGrid, TileLink } from "../../src/patterns/index.ts";
import { expectNoViolations } from "../support.tsx";

describe("TileLink", () => {
  const renderTiles = () =>
    render(
      <TileGrid label="Quick access">
        <TileLink hint="https://example.com/docs" href="/go/docs" monogram="e" subtitle="example.com" title="Example docs" />
        <TileLink monogram="p" title="Plain" />
      </TileGrid>,
    );

  it("lists its tiles, links the title with the hint on hover and shows the subtitle in mono", () => {
    renderTiles();

    const list = screen.getByRole("list", { name: "Quick access" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    const link = screen.getByRole("link", { name: "Example docs" });
    expect(link.getAttribute("href")).toBe("/go/docs");
    expect(link.getAttribute("title")).toBe("https://example.com/docs");
    expect(screen.getByText("example.com").className).toContain("font-mono");
    expect(screen.queryByRole("link", { name: "Plain" })).toBeNull();
    expect(screen.getByText("Plain")).toBeTruthy();
  });

  it("is free of accessibility violations", async () => {
    const { container } = renderTiles();

    await expectNoViolations(container);
  });

  it("calls back when the link is followed with a click or a middle click, and for no other button", () => {
    const onOpen = vi.fn<() => void>();
    render(
      <TileGrid label="Tiles">
        <TileLink href="/go/docs" monogram="d" onOpen={onOpen} title="Docs" />
      </TileGrid>,
    );
    const link = screen.getByRole("link", { name: "Docs" });

    fireEvent.click(link);
    fireEvent(link, new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    fireEvent(link, new MouseEvent("auxclick", { bubbles: true, button: 2 }));

    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it("draws a title and a subtitle as text, whatever they hold", () => {
    const { container } = render(
      <TileGrid label="Tiles">
        <TileLink monogram="x" subtitle="<b>host</b>" title="<img src=x onerror=alert(1)>" />
      </TileGrid>,
    );

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy();
  });
});
