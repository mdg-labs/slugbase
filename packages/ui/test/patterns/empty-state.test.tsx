import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EmptyState } from "../../src/patterns/index.ts";
import { expectNoViolations } from "../support.tsx";

describe("EmptyState", () => {
  it("says what is missing, why and what to do, with the title at the level it is given", async () => {
    const { container } = render(
      <EmptyState
        actions={<button type="button">Add</button>}
        description="Nothing yet."
        headingLevel={1}
        icon={<svg aria-hidden="true" />}
        title="No bookmarks"
      />,
    );

    expect(screen.getByRole("heading", { name: "No bookmarks", level: 1 })).toBeTruthy();
    expect(screen.getByText("Nothing yet.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add" })).toBeTruthy();
    await expectNoViolations(container);
  });

  it("renders a title alone as a level 2 heading", async () => {
    const { container } = render(<EmptyState title="Nothing" />);

    expect(screen.getByRole("heading", { name: "Nothing", level: 2 })).toBeTruthy();
    await expectNoViolations(container);
  });
});
