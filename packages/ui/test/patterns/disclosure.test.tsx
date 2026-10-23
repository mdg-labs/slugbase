import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Disclosure } from "../../src/patterns/index.ts";
import { expectNoViolations } from "../support.tsx";

describe("Disclosure", () => {
  it("hides its content until the control is used, and hides it again", async () => {
    const { container } = render(
      <Disclosure label="More">
        <p>Optional fields</p>
      </Disclosure>,
    );

    const control = screen.getByRole("button", { name: "More" });
    expect(control.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Optional fields")).toBeNull();

    fireEvent.click(control);
    expect(control.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Optional fields")).toBeTruthy();
    await expectNoViolations(container);

    fireEvent.click(control);
    expect(control.getAttribute("aria-expanded")).toBe("false");
  });

  it("starts open when asked to", () => {
    render(
      <Disclosure defaultOpen label="More">
        <p>Optional fields</p>
      </Disclosure>,
    );

    expect(screen.getByText("Optional fields")).toBeTruthy();
  });
});
