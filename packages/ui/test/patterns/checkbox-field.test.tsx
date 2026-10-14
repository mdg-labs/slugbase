import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CheckboxField } from "../../src/patterns/index.ts";
import { expectNoViolations } from "../support.tsx";

describe("CheckboxField", () => {
  it("is named by its label, and clicking the label toggles it", () => {
    const onCheckedChange = vi.fn<(checked: boolean) => void>();
    render(<CheckboxField label="Remember me" onCheckedChange={onCheckedChange} />);
    const box = screen.getByRole("checkbox", { name: "Remember me" });
    expect(box.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(screen.getByText("Remember me"));

    expect(onCheckedChange).toHaveBeenCalledWith(true, expect.anything());
    expect(box.getAttribute("aria-checked")).toBe("true");
  });

  it("starts checked when asked to", () => {
    render(<CheckboxField defaultChecked label="Remember me" />);

    expect(screen.getByRole("checkbox", { name: "Remember me" }).getAttribute("aria-checked")).toBe("true");
  });

  it("is free of accessibility violations in both themes", async () => {
    for (const dark of [false, true]) {
      document.documentElement.classList.toggle("dark", dark);
      const { container, unmount } = render(<CheckboxField label="Remember me" />);
      await expectNoViolations(container);
      unmount();
    }
  });
});
