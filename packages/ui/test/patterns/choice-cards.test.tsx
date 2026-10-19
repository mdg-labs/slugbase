import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChoiceCards } from "../../src/patterns/index.ts";
import { expectNoViolations } from "../support.tsx";

const OPTIONS = [
  { value: "transfer", label: "Transfer the content", description: "The bookmarks and folders go to another member." },
  { value: "delete", label: "Delete the content", description: "They are removed with the membership." },
];

describe("ChoiceCards", () => {
  it("is a radio group named by its label, each card named by its title and described by its text", async () => {
    const { container } = render(<ChoiceCards description="Choose one." label="Content" onValueChange={() => undefined} options={OPTIONS} value="transfer" />);

    const group = screen.getByRole("radiogroup", { name: "Content" });
    expect(group.getAttribute("aria-describedby")).toBeTruthy();
    const transfer = screen.getByRole("radio", { name: "Transfer the content" });
    expect(transfer.getAttribute("aria-checked")).toBe("true");
    expect(transfer.getAttribute("aria-describedby")).toBe(screen.getByText("The bookmarks and folders go to another member.").id);
    expect(screen.getByRole("radio", { name: "Delete the content" }).getAttribute("aria-checked")).toBe("false");
    await expectNoViolations(container);
  });

  it("reports the card the member chooses", () => {
    const onValueChange = vi.fn<(value: string) => void>();
    render(<ChoiceCards label="Content" onValueChange={onValueChange} options={OPTIONS} value="transfer" />);

    fireEvent.click(screen.getByRole("radio", { name: "Delete the content" }));

    expect(onValueChange).toHaveBeenCalledExactlyOnceWith("delete");
  });

  it("marks the group invalid and describes it by the error", async () => {
    const { container } = render(<ChoiceCards error="Choose one." label="Content" onValueChange={() => undefined} options={OPTIONS} value="transfer" />);

    const group = screen.getByRole("radiogroup", { name: "Content" });
    expect(group.getAttribute("aria-invalid")).toBe("true");
    expect(group.getAttribute("aria-describedby")?.split(" ")).toContain(screen.getByText("Choose one.").id);
    await expectNoViolations(container);
  });

  it("reports nothing for a disabled card or a disabled group", () => {
    const onValueChange = vi.fn<(value: string) => void>();
    const { rerender } = render(
      <ChoiceCards label="Content" onValueChange={onValueChange} options={OPTIONS.map((option) => ({ ...option, disabled: option.value === "transfer" }))} value="delete" />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Transfer the content" }));
    rerender(<ChoiceCards disabled label="Content" onValueChange={onValueChange} options={OPTIONS} value="transfer" />);
    fireEvent.click(screen.getByRole("radio", { name: "Delete the content" }));

    expect(onValueChange).not.toHaveBeenCalled();
  });
});
