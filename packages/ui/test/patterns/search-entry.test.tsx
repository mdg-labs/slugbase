import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SearchEntry } from "../../src/patterns/index.ts";
import { expectNoViolations } from "../support.tsx";

describe("SearchEntry", () => {
  it("is a button named by its prompt that shows the shortcut and calls back when pressed", async () => {
    const onClick = vi.fn<() => void>();
    const { container } = render(<SearchEntry label="Search everything" onClick={onClick} shortcut={["Ctrl", "K"]} />);

    const button = screen.getByRole("button", { name: "Search everything" });
    expect(Array.from(container.querySelectorAll("kbd")).map((key) => key.textContent)).toEqual(["Ctrl", "K"]);
    fireEvent.click(button);

    expect(onClick).toHaveBeenCalledTimes(1);
    await expectNoViolations(container);
  });
});
