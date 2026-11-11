import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Input } from "../../src/index.ts";
import { FormField } from "../../src/patterns/index.ts";
import { expectNoViolations } from "../support.tsx";

describe("FormField", () => {
  it("names the control by its label and describes it by its description", () => {
    render(
      <FormField description="The address you registered with." label="Email">
        <Input type="email" />
      </FormField>,
    );

    const field = screen.getByRole("textbox", { name: "Email" });
    expect(field.getAttribute("aria-invalid")).toBeNull();
    expect(field.getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.getByText("The address you registered with.").id).toBe(field.getAttribute("aria-describedby"));
  });

  it("is free of accessibility violations with a description", async () => {
    const { container } = render(
      <FormField description="The address you registered with." label="Email">
        <Input type="email" />
      </FormField>,
    );

    await expectNoViolations(container);
  });

  it("marks the control invalid and describes it by the error", () => {
    render(
      <FormField error="Enter your email address." label="Email">
        <Input type="email" />
      </FormField>,
    );

    const field = screen.getByRole("textbox", { name: "Email" });
    expect(field.getAttribute("aria-invalid")).toBe("true");
    const error = screen.getByText("Enter your email address.");
    expect(field.getAttribute("aria-describedby")?.split(" ")).toContain(error.id);
  });

  it("is free of accessibility violations with an error", async () => {
    const { container } = render(
      <FormField error="Enter your email address." label="Email">
        <Input type="email" />
      </FormField>,
    );

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

  it("keeps a hidden label as the name of the control, for assistive technology only", async () => {
    const { container } = render(
      <FormField hideLabel label="Search">
        <Input type="search" />
      </FormField>,
    );

    expect(screen.getByRole("searchbox", { name: "Search" })).toBeTruthy();
    expect(screen.getByText("Search").className).toContain("sr-only");
    await expectNoViolations(container);
  });

  it("shows the label unless it is hidden", () => {
    render(
      <FormField label="Search">
        <Input type="search" />
      </FormField>,
    );

    expect(screen.getByText("Search").className).not.toContain("sr-only");
  });
});
