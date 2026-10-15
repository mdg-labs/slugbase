import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { FormField, Totp } from "../../src/patterns/index.ts";
import { expectNoViolations } from "../support.tsx";

const slotLabel = (position: number, length: number): string => `Digit ${String(position)} of ${String(length)}`;

function Code({ onComplete, error, disabled }: { onComplete?: (value: string) => void; error?: string; disabled?: boolean }): React.ReactElement {
  const [value, setValue] = useState("");
  return (
    <FormField error={error} label="Authentication code">
      <Totp disabled={disabled} onComplete={onComplete} onValueChange={setValue} slotLabel={slotLabel} value={value} />
    </FormField>
  );
}

function slots(): HTMLInputElement[] {
  return screen.getAllByRole<HTMLInputElement>("textbox", { hidden: false }).filter((input) => input.getAttribute("aria-hidden") !== "true");
}

describe("Totp", () => {
  it("renders one slot per digit, the first named by the field label and the others by their position", () => {
    render(<Code />);

    expect(slots()).toHaveLength(6);
    expect(screen.getByRole("textbox", { name: "Authentication code" })).toBe(slots()[0]);
    expect(screen.getByRole("textbox", { name: "Digit 4 of 6" })).toBe(slots()[3]);
    expect(slots()[0]?.getAttribute("autocomplete")).toBe("one-time-code");
  });

  it("reports the code once, when the sixth digit is entered", () => {
    const onComplete = vi.fn();
    render(<Code onComplete={onComplete} />);

    fireEvent.change(slots()[0] as HTMLInputElement, { target: { value: "12345" } });
    expect(onComplete).not.toHaveBeenCalled();

    fireEvent.change(slots()[5] as HTMLInputElement, { target: { value: "6" } });

    expect(onComplete).toHaveBeenCalledExactlyOnceWith("123456", expect.anything());
  });

  it("fills the slots from a pasted code and ignores what is not a digit", () => {
    const onComplete = vi.fn();
    render(<Code onComplete={onComplete} />);

    fireEvent.paste(slots()[0] as HTMLInputElement, { clipboardData: { getData: () => "12a 3456" } });

    expect(slots().map((slot) => slot.value).join("")).toBe("123456");
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("marks the slots invalid and ties the message to the field", () => {
    render(<Code error="That code is not valid." />);

    expect(slots().every((slot) => slot.getAttribute("aria-invalid") === "true")).toBe(true);
    expect(screen.getByText("That code is not valid.")).toBeTruthy();
  });

  it("disables every slot", () => {
    render(<Code disabled />);

    expect(slots().every((slot) => slot.disabled)).toBe(true);
  });

  it("is free of accessibility violations in both themes", async () => {
    for (const dark of [false, true]) {
      document.documentElement.classList.toggle("dark", dark);
      const { container, unmount } = render(<Code error="That code is not valid." />);
      await expectNoViolations(container);
      unmount();
    }
  });
});
