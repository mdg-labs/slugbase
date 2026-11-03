import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GroupedResults } from "../../src/patterns/index.ts";
import { expectNoViolations, stubBrowserApis } from "../support.tsx";

function Result({ defaultOpen }: { defaultOpen?: readonly string[] }): React.ReactElement {
  return (
    <GroupedResults
      defaultOpen={defaultOpen}
      groups={[
        { id: "duplicate", label: "Duplicates", count: 2, countLabel: "2", children: <p>Same page</p> },
        { id: "empty", label: "Nothing here", count: 0, children: <p>Never shown</p> },
        { id: "limit", label: "No room", count: 1200, countLabel: "1,200", children: <p>Past the limit</p> },
      ]}
    />
  );
}

describe("GroupedResults", () => {
  it("shows a count Badge on each group's heading and leaves out a group without entries", async () => {
    stubBrowserApis();
    const { container } = render(<Result />);

    const duplicates = screen.getByRole("button", { name: /Duplicates/ });
    expect(duplicates.textContent).toContain("2");
    expect(screen.getByRole("button", { name: /No room/ }).textContent).toContain("1,200");
    expect(screen.queryByText("Nothing here")).toBeNull();
    expect(container.querySelectorAll("[data-slot=badge]")).toHaveLength(2);
    expect(screen.queryByText("Same page")).toBeNull();
    await expectNoViolations(container);
  });

  it("lets several groups stay open at once", async () => {
    stubBrowserApis();
    const { container } = render(<Result />);

    fireEvent.click(screen.getByRole("button", { name: /Duplicates/ }));
    fireEvent.click(screen.getByRole("button", { name: /No room/ }));

    expect(screen.getByText("Same page")).toBeTruthy();
    expect(screen.getByText("Past the limit")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Duplicates/ }).getAttribute("aria-expanded")).toBe("true");
    await expectNoViolations(container);
  });

  it("starts with the groups it is told to open, and the count of a group without a label is the number", () => {
    stubBrowserApis();
    render(
      <GroupedResults defaultOpen={["a"]} groups={[{ id: "a", label: "Group", count: 3, children: <p>Inside</p> }]} />,
    );

    expect(screen.getByText("Inside")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Group/ }).textContent).toContain("3");
  });

  it("renders nothing when every group is empty", () => {
    stubBrowserApis();
    const { container } = render(<GroupedResults groups={[{ id: "a", label: "Group", count: 0, children: null }]} />);

    expect(container.childElementCount).toBe(0);
  });
});
