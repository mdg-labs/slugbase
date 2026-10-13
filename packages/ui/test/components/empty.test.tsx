import { render, screen } from "@testing-library/react";
import { InboxIcon } from "lucide-react";
import { describe, expect, it } from "vitest";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../../src/index.ts";
import { expectNoViolations } from "../support.tsx";

describe("Empty", () => {
  it("renders the title, description and content of an empty state", async () => {
    const { container } = render(
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <InboxIcon aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>No bookmarks yet</EmptyTitle>
          <EmptyDescription>Add your first bookmark to see it here.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <button type="button">Add bookmark</button>
        </EmptyContent>
      </Empty>,
    );

    expect(screen.getByText("No bookmarks yet")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add bookmark" })).toBeTruthy();
    await expectNoViolations(container);
  });
});
