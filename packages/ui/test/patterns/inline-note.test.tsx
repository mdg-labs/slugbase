import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { InlineNote } from "../../src/patterns/index.ts";
import { expectNoViolations } from "../support.tsx";

describe("InlineNote", () => {
  it("shows its text as a note that is not announced as an alert", () => {
    render(<InlineNote>Printed to the server log.</InlineNote>);

    expect(screen.getByRole("note").textContent).toContain("Printed to the server log.");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows its title above the text", () => {
    render(<InlineNote title="Where is it?">In the log.</InlineNote>);

    const note = screen.getByRole("note");
    expect(note.textContent).toContain("Where is it?");
    expect(note.textContent).toContain("In the log.");
  });

  it("is free of accessibility violations in both themes", async () => {
    for (const dark of [false, true]) {
      document.documentElement.classList.toggle("dark", dark);
      const { container, unmount } = render(<InlineNote title="Title">Text</InlineNote>);
      await expectNoViolations(container);
      unmount();
    }
  });
});
