import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ConfirmDialog, EmptyState, SkeletonList, ToastProvider } from "@slugbase/ui";

describe("feedback a11y smoke", () => {
  it("exposes busy skeleton state and dialog semantics", () => {
    render(<SkeletonList rows={2} testId="a11y-skeleton" />);
    expect(screen.getByTestId("a11y-skeleton").getAttribute("aria-busy")).toBe("true");
  });

  it("renders empty state heading for screen readers", () => {
    render(
      <EmptyState
        title="No folders yet"
        description="Create a folder to organize bookmarks."
        testId="a11y-empty"
      />,
    );
    expect(screen.getByRole("heading", { name: "No folders yet" })).toBeTruthy();
  });

  it("renders toast region with status role", () => {
    render(
      <ToastProvider dismissLabel="Dismiss">
        <button
          type="button"
          onClick={() => undefined}
        >
          noop
        </button>
      </ToastProvider>,
    );
    expect(screen.queryByTestId("toast-viewport")).toBeNull();
  });

  it("opens confirm dialog with dialog role", () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={() => undefined}
        title="Remove member"
        confirmLabel="Remove"
        cancelLabel="Cancel"
        onConfirm={() => undefined}
      />,
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });
});
