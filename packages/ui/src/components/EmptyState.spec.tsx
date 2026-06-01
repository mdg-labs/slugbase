import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { EmptyState } from "./EmptyState.js";

describe("EmptyState", () => {
  it("renders title, description, and actions with accessible structure", () => {
    render(
      <EmptyState
        title="No bookmarks yet"
        description="Save your first link."
        actions={<button type="button">New bookmark</button>}
        testId="bookmarks-empty"
      />,
    );

    expect(screen.getByTestId("bookmarks-empty")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "No bookmarks yet" })).toBeTruthy();
    expect(screen.getByText("Save your first link.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "New bookmark" })).toBeTruthy();
  });
});
