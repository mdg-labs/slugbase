import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CopyValue } from "../../src/patterns/index.ts";
import { expectNoViolations } from "../support.tsx";

function Value(): React.ReactElement {
  return <CopyValue copiedLabel="Copied" copyLabel="Copy request ID" label="Request ID" value="req-4711" />;
}

describe("CopyValue", () => {
  it("shows the value in a read-only field", async () => {
    const { container } = render(<Value />);

    const field = screen.getByRole<HTMLInputElement>("textbox", { name: "Request ID" });
    expect(field.value).toBe("req-4711");
    expect(field.readOnly).toBe(true);
    await expectNoViolations(container);
  });

  it("copies the value, says so, and goes back to the copy label", async () => {
    vi.useFakeTimers();
    try {
      const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
      vi.stubGlobal("navigator", { clipboard: { writeText } });
      render(<Value />);

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Copy request ID" }));
        await Promise.resolve();
      });

      expect(writeText).toHaveBeenCalledWith("req-4711");
      expect(screen.getByRole("status").textContent).toBe("Copied");
      expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();

      act(() => {
        vi.advanceTimersByTime(2500);
      });

      expect(screen.getByRole("button", { name: "Copy request ID" })).toBeTruthy();
      expect(screen.getByRole("status").textContent).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("claims no success and selects the value when the clipboard refuses", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: () => Promise.reject(new DOMException("denied", "NotAllowedError")) } });
    render(<Value />);
    const field = screen.getByRole<HTMLInputElement>("textbox", { name: "Request ID" });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy request ID" }));
      await Promise.resolve();
    });

    expect(screen.getByRole("status").textContent).toBe("");
    expect(screen.getByRole("button", { name: "Copy request ID" })).toBeTruthy();
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, "req-4711".length]);
  });

  it("claims no success when there is no clipboard", async () => {
    vi.stubGlobal("navigator", {});
    render(<Value />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy request ID" }));
      await Promise.resolve();
    });

    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("is free of accessibility violations in both themes", async () => {
    for (const dark of [false, true]) {
      document.documentElement.classList.toggle("dark", dark);
      const { container, unmount } = render(<Value />);
      await expectNoViolations(container);
      unmount();
    }
  });
});
