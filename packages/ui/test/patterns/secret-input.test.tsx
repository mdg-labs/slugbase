import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FormField, SecretInput } from "../../src/patterns/index.ts";
import { expectNoViolations } from "../support.tsx";

function Password(): React.ReactElement {
  return (
    <FormField label="Password">
      <SecretInput hideLabel="Hide password" showLabel="Show password" />
    </FormField>
  );
}

describe("SecretInput", () => {
  it("starts hidden, and the toggle shows and hides the value", () => {
    render(<Password />);
    const field = screen.getByLabelText<HTMLInputElement>("Password");
    expect(field.type).toBe("password");

    fireEvent.click(screen.getByRole("button", { name: "Show password" }));

    expect(field.type).toBe("text");
    expect(screen.getByRole("button", { name: "Hide password" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Hide password" }));

    expect(field.type).toBe("password");
  });

  it("keeps what was typed when the value is shown", () => {
    render(<Password />);
    const field = screen.getByLabelText<HTMLInputElement>("Password");
    fireEvent.change(field, { target: { value: "correct horse" } });

    fireEvent.click(screen.getByRole("button", { name: "Show password" }));

    expect(field.value).toBe("correct horse");
  });

  it("is free of accessibility violations in both themes", async () => {
    for (const dark of [false, true]) {
      document.documentElement.classList.toggle("dark", dark);
      const { container, unmount } = render(<Password />);
      await expectNoViolations(container);
      unmount();
    }
  });
});
