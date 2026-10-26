import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FormField, SlugInput } from "../../src/patterns/index.ts";
import { expectNoViolations } from "../support.tsx";

describe("SlugInput", () => {
  it("shows the fixed /go/ start text before a mono field named by its label", async () => {
    const { container } = render(
      <FormField label="Slug">
        <SlugInput onValueChange={() => undefined} pendingLabel="Checking" value="mail" />
      </FormField>,
    );

    const field = screen.getByRole<HTMLInputElement>("textbox", { name: "Slug" });
    expect(field.value).toBe("mail");
    expect(field.parentElement?.className).toContain("font-mono");
    const start = screen.getByText("/go/");
    expect(start.getAttribute("translate")).toBe("no");
    expect(field.getAttribute("translate")).toBe("no");
    await expectNoViolations(container);
  });

  it("reports what is typed trimmed and lower-cased", () => {
    const onValueChange = vi.fn<(value: string) => void>();
    render(
      <FormField label="Slug">
        <SlugInput onValueChange={onValueChange} pendingLabel="Checking" value="" />
      </FormField>,
    );
    const field = screen.getByRole("textbox", { name: "Slug" });

    fireEvent.change(field, { target: { value: "  GitHub-Docs " } });

    expect(onValueChange).toHaveBeenLastCalledWith("github-docs");
  });

  it("reports the blur", () => {
    const onBlur = vi.fn();
    render(
      <FormField label="Slug">
        <SlugInput onBlur={onBlur} onValueChange={() => undefined} pendingLabel="Checking" value="" />
      </FormField>,
    );

    fireEvent.blur(screen.getByRole("textbox", { name: "Slug" }));

    expect(onBlur).toHaveBeenCalledTimes(1);
  });

  it("shows the spinner only while pending, and is disabled when told to be", () => {
    const { rerender } = render(
      <FormField label="Slug">
        <SlugInput onValueChange={() => undefined} pendingLabel="Checking the slug" value="" />
      </FormField>,
    );
    expect(screen.queryByRole("status", { name: "Checking the slug" })).toBeNull();

    rerender(
      <FormField label="Slug">
        <SlugInput disabled onValueChange={() => undefined} pending pendingLabel="Checking the slug" value="" />
      </FormField>,
    );
    expect(screen.getByRole("status", { name: "Checking the slug" })).toBeTruthy();
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Slug" }).disabled).toBe(true);
  });
});
