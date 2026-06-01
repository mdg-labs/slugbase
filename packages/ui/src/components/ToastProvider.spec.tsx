import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ToastProvider, useToast } from "./ToastProvider.js";

function ToastHarness() {
  const { toast } = useToast();
  return (
    <button
      type="button"
      onClick={() => {
        toast({ title: "Saved", description: "Profile updated", kind: "success" });
      }}
    >
      Show toast
    </button>
  );
}

describe("ToastProvider", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("shows and dismisses toasts with keyboard-friendly controls", () => {
    render(
      <ToastProvider dismissLabel="Dismiss notification">
        <ToastHarness />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Show toast" }));
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByText("Saved")).toBeTruthy();
    expect(screen.getByText("Profile updated")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("auto-dismisses after the default duration", () => {
    vi.useFakeTimers();
    render(
      <ToastProvider dismissLabel="Dismiss notification">
        <ToastHarness />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Show toast" }));
    expect(screen.getByText("Saved")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(3200);
    });

    expect(screen.queryByText("Saved")).toBeNull();
    vi.useRealTimers();
  });
});
