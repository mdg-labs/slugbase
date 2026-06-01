import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { ConfirmDialog } from "./ConfirmDialog.js";

function ConfirmHarness() {
  const [open, setOpen] = useState(false);
  const onConfirm = vi.fn();

  return (
    <>
      <button type="button" onClick={() => { setOpen(true); }}>
        Open confirm
      </button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Remove member"
        description="This cannot be undone."
        confirmLabel="Remove"
        cancelLabel="Cancel"
        destructive
        onConfirm={() => {
          onConfirm();
          setOpen(false);
        }}
      />
    </>
  );
}

describe("ConfirmDialog", () => {
  it("supports keyboard-friendly confirm and cancel actions", () => {
    render(<ConfirmHarness />);

    fireEvent.click(screen.getByRole("button", { name: "Open confirm" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("Remove member")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
