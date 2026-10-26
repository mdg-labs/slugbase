import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Tabs, TabsList, TabsPanel, TabsTab } from "../../src/index.ts";
import { expectNoViolations, stubBrowserApis } from "../support.tsx";

function Browsers(): React.ReactElement {
  return (
    <Tabs defaultValue="chrome">
      <TabsList aria-label="Browser">
        <TabsTab value="chrome">Chrome</TabsTab>
        <TabsTab value="firefox">Firefox</TabsTab>
      </TabsList>
      <TabsPanel value="chrome">Chrome steps</TabsPanel>
      <TabsPanel value="firefox">Firefox steps</TabsPanel>
    </Tabs>
  );
}

describe("Tabs", () => {
  it("shows the panel of the selected tab and switches on a click", async () => {
    stubBrowserApis();
    const { container } = render(<Browsers />);

    expect(screen.getByRole("tablist", { name: "Browser" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "Chrome" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Chrome steps")).toBeDefined();
    expect(screen.queryByText("Firefox steps")).toBeNull();
    await expectNoViolations(container);

    fireEvent.click(screen.getByRole("tab", { name: "Firefox" }));

    expect(screen.getByRole("tab", { name: "Firefox" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Firefox steps")).toBeDefined();
  });

  it("renders inactive tab text at full muted-foreground, not a reduced-opacity colour", () => {
    stubBrowserApis();
    render(<Browsers />);

    const list = screen.getByRole("tablist", { name: "Browser" });
    const inactive = screen.getByRole("tab", { name: "Firefox" });

    expect(inactive.getAttribute("aria-selected")).toBe("false");
    expect(list.className).toContain("text-muted-foreground");
    expect(list.className).not.toMatch(/text-muted-foreground\/\d+/);
  });
});
