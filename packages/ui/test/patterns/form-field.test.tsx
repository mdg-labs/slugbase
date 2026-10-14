import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Input } from "../../src/index.ts";
import { FormField } from "../../src/patterns/index.ts";
import { expectNoViolations } from "../support.tsx";

describe("FormField", () => {
  it("names the control by its label and describes it by its description", async () => {
    const { container } = render(
      <FormField description="The address you registered with." label="Email">
        <Input type="email" />
      </FormField>,
    );

    const field = screen.getByRole("textbox", { name: "Email" });
    expect(field.getAttribute("aria-invalid")).toBeNull();
    expect(field.getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.getByText("The address you registered with.").id).toBe(field.getAttribute("aria-describedby"));
    await expectNoViolations(container);
  });

  it("marks the control invalid and describes it by the error", async () => {
    const { container } = render(
      <FormField error="Enter your email address." label="Email">
        <Input type="email" />
      </FormField>,
    );

    const field = screen.getByRole("textbox", { name: "Email" });
    expect(field.getAttribute("aria-invalid")).toBe("true");
    const error = screen.getByText("Enter your email address.");
    expect(field.getAttribute("aria-describedby")?.split(" ")).toContain(error.id);
    await expectNoViolations(container);
  });

  it("shows no error element while there is no error", () => {
    render(
      <FormField label="Email">
        <Input type="email" />
      </FormField>,
    );

    expect(screen.getByRole("textbox", { name: "Email" }).getAttribute("aria-describedby")).toBeNull();
  });
});
