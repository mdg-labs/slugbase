import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Toggle, ToggleGroup, ToggleGroupItem } from "../../src/index.ts";
import { expectNoViolations } from "../support.tsx";

describe("Toggle", () => {
  it("is a button that reports whether it is pressed", async () => {
    const { container } = render(<Toggle>Pinned</Toggle>);
    const toggle = screen.getByRole("button", { name: "Pinned" });

    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.getAttribute("data-slot")).toBe("toggle");
    await expectNoViolations(container);

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("ToggleGroup", () => {
  it("is a named group whose items are pressed independently when it takes several", async () => {
    const onValueChange = vi.fn<(value: readonly string[]) => void>();
    const { container } = render(
      <ToggleGroup aria-label="Filters" multiple onValueChange={onValueChange} value={["pinned"]} variant="outline">
        <ToggleGroupItem value="pinned">Pinned</ToggleGroupItem>
        <ToggleGroupItem value="slug">Has slug</ToggleGroupItem>
      </ToggleGroup>,
    );

    expect(screen.getByRole("group", { name: "Filters" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Pinned" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Has slug" }).getAttribute("aria-pressed")).toBe("false");
    await expectNoViolations(container);

    fireEvent.click(screen.getByRole("button", { name: "Has slug" }));

    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange.mock.calls[0]?.[0]).toEqual(["pinned", "slug"]);
  });

  it("gives its items the group's variant and size", () => {
    render(
      <ToggleGroup aria-label="Filters" size="sm" variant="outline">
        <ToggleGroupItem value="pinned">Pinned</ToggleGroupItem>
      </ToggleGroup>,
    );
    const item = screen.getByRole("button", { name: "Pinned" });

    expect(item.getAttribute("data-variant")).toBe("outline");
    expect(item.getAttribute("data-size")).toBe("sm");
  });
});
