import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TagLink } from "../../src/patterns/index.ts";
import { expectNoViolations } from "../support.tsx";

describe("TagLink", () => {
  it("renders the given link as a badge holding the name and the count", async () => {
    const { container } = render(<TagLink count="12" link={<a href="/bookmarks?tag=1" />} name="Reading" />);

    const link = screen.getByRole("link", { name: "Reading 12" });
    expect(link.getAttribute("href")).toBe("/bookmarks?tag=1");
    expect(link.getAttribute("data-slot")).toBe("tag-link");
    expect(screen.getByText("12").className).toContain("tabular-nums");
    await expectNoViolations(container);
  });

  it("draws the name as text, whatever it holds", () => {
    const { container } = render(<TagLink count="1" link={<a href="#" />} name="<img src=x onerror=alert(1)>" />);

    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy();
  });
});
