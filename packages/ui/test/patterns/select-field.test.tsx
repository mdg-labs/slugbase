import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SelectField } from "../../src/patterns/index.ts";
import { expectNoViolations, stubBrowserApis } from "../support.tsx";

const LANGUAGES = [
  { value: "en", label: "English" },
  { value: "de", label: "Deutsch" },
];

beforeEach(() => {
  stubBrowserApis();
});

describe("SelectField", () => {
  it("names the select by its label, shows the label of the chosen option and describes it", async () => {
    const { container } = render(
      <SelectField description="The language of the app." label="Language" onValueChange={() => undefined} options={LANGUAGES} value="de" />,
    );

    const select = screen.getByRole("combobox", { name: "Language" });
    expect(select.textContent).toContain("Deutsch");
    expect(select.getAttribute("aria-describedby")).toBeTruthy();
    await expectNoViolations(container);
  });

  it("reports the option the member chooses", async () => {
    const onValueChange = vi.fn<(value: string) => void>();
    render(<SelectField label="Language" onValueChange={onValueChange} options={LANGUAGES} value="en" />);

    await act(async () => {
      fireEvent.click(screen.getByRole("combobox", { name: "Language" }));
      await Promise.resolve();
    });
    await act(async () => {
      const option = await screen.findByRole("option", { name: "Deutsch" });
      // Base UI commits a click only after the press began on the item.
      fireEvent.pointerDown(option);
      fireEvent.click(option);
      await Promise.resolve();
    });

    expect(onValueChange).toHaveBeenCalledExactlyOnceWith("de");
  });

  it("marks the select invalid and describes it by the error", async () => {
    const { container } = render(<SelectField error="Choose a language." label="Language" onValueChange={() => undefined} options={LANGUAGES} value="en" />);

    const select = screen.getByRole("combobox", { name: "Language" });
    expect(select.getAttribute("aria-invalid")).toBe("true");
    const error = screen.getByText("Choose a language.");
    expect(select.getAttribute("aria-describedby")?.split(" ")).toContain(error.id);
    await expectNoViolations(container);
  });

  it("does not open while disabled", async () => {
    render(<SelectField disabled label="Language" onValueChange={() => undefined} options={LANGUAGES} value="en" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("combobox", { name: "Language" }));
      await Promise.resolve();
    });
    expect(screen.queryByRole("option")).toBeNull();
  });
});
