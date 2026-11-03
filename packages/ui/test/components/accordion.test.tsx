import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Accordion, AccordionItem, AccordionPanel, AccordionTrigger } from "../../src/index.ts";
import { expectNoViolations, stubBrowserApis } from "../support.tsx";

function Questions({ multiple }: { multiple: boolean }): React.ReactElement {
  return (
    <Accordion multiple={multiple}>
      <AccordionItem value="first">
        <AccordionTrigger>First</AccordionTrigger>
        <AccordionPanel>First answer</AccordionPanel>
      </AccordionItem>
      <AccordionItem value="second">
        <AccordionTrigger>Second</AccordionTrigger>
        <AccordionPanel>Second answer</AccordionPanel>
      </AccordionItem>
    </Accordion>
  );
}

describe("Accordion", () => {
  it("opens and closes an item from its trigger", async () => {
    stubBrowserApis();
    const { container } = render(<Questions multiple={false} />);

    const first = screen.getByRole("button", { name: "First" });
    expect(first.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(first);
    expect(first.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("First answer")).toBeDefined();
    await expectNoViolations(container);

    fireEvent.click(screen.getByRole("button", { name: "Second" }));
    expect(first.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps several items open when it allows them", () => {
    stubBrowserApis();
    render(<Questions multiple />);

    fireEvent.click(screen.getByRole("button", { name: "First" }));
    fireEvent.click(screen.getByRole("button", { name: "Second" }));

    expect(screen.getByRole("button", { name: "First" }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "Second" }).getAttribute("aria-expanded")).toBe("true");
  });
});
