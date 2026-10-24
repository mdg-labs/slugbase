import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FormField, UrlInput } from "../../src/patterns/index.ts";
import { expectNoViolations } from "../support.tsx";

describe("UrlInput", () => {
  it("is a URL field named by its label", async () => {
    const { container } = render(
      <FormField label="URL">
        <UrlInput onValueChange={() => undefined} pendingLabel="Checking" value="https://slugbase.app" />
      </FormField>,
    );

    const field = screen.getByRole("textbox", { name: "URL" });
    expect(field.getAttribute("type")).toBe("url");
    expect((field as HTMLInputElement).value).toBe("https://slugbase.app");
    await expectNoViolations(container);
  });

  it("reports what is typed, the paste and the blur", () => {
    const onValueChange = vi.fn<(value: string) => void>();
    const onPaste = vi.fn();
    const onBlur = vi.fn();
    render(
      <FormField label="URL">
        <UrlInput onBlur={onBlur} onPaste={onPaste} onValueChange={onValueChange} pendingLabel="Checking" value="" />
      </FormField>,
    );
    const field = screen.getByRole("textbox", { name: "URL" });

    fireEvent.change(field, { target: { value: "https://a.example" } });
    fireEvent.paste(field);
    fireEvent.blur(field);

    expect(onValueChange).toHaveBeenCalledWith("https://a.example");
    expect(onPaste).toHaveBeenCalledTimes(1);
    expect(onBlur).toHaveBeenCalledTimes(1);
  });

  it("shows the spinner only while pending", () => {
    const { rerender } = render(
      <FormField label="URL">
        <UrlInput onValueChange={() => undefined} pendingLabel="Checking the address" value="" />
      </FormField>,
    );
    expect(screen.queryByRole("status", { name: "Checking the address" })).toBeNull();

    rerender(
      <FormField label="URL">
        <UrlInput onValueChange={() => undefined} pending pendingLabel="Checking the address" value="" />
      </FormField>,
    );
    expect(screen.getByRole("status", { name: "Checking the address" })).toBeTruthy();
  });
});
