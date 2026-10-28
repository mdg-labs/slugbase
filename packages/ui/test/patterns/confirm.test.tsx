import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Confirm } from "../../src/patterns/index.ts";
import { expectNoViolations, stubBrowserApis } from "../support.tsx";

function Harness({ onConfirm, loading = false }: { onConfirm: () => void; loading?: boolean }): ReactElement {
  const [open, setOpen] = useState(true);
  return (
    <Confirm
      cancelLabel="Cancel"
      confirmLabel="Remove"
      description="The bookmarks stay."
      destructive
      loading={loading}
      onConfirm={onConfirm}
      onOpenChange={setOpen}
      open={open}
      title="Delete the folder?"
    />
  );
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
}

beforeEach(() => {
  stubBrowserApis();
});

describe("Confirm", () => {
  it("is an alert dialog named by its title and described by what it does", async () => {
    render(<Harness onConfirm={() => undefined} />);

    const dialog = await screen.findByRole("alertdialog", { name: "Delete the folder?" });
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.getByText("The bookmarks stay.").id).toBe(dialog.getAttribute("aria-describedby"));
  });

  it("is free of accessibility violations", async () => {
    render(<Harness onConfirm={() => undefined} />);
    await screen.findByRole("alertdialog");

    await expectNoViolations(document.body);
  });

  it("starts with focus on Cancel, so Enter does not confirm", async () => {
    render(<Harness onConfirm={() => undefined} />);

    await screen.findByRole("alertdialog");
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
    });
  });

  it("calls onConfirm for the confirm button and nothing for Cancel, which closes it", async () => {
    const onConfirm = vi.fn<() => void>();
    render(<Harness onConfirm={onConfirm} />);
    await screen.findByRole("alertdialog");

    await click(screen.getByRole("button", { name: "Cancel" }));

    expect(onConfirm).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
  });

  it("calls onConfirm once for the confirm button and leaves closing it to the app", async () => {
    const onConfirm = vi.fn<() => void>();
    render(<Harness onConfirm={onConfirm} />);
    await screen.findByRole("alertdialog");

    await click(screen.getByRole("button", { name: "Remove" }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });

  it("cannot be dismissed, and cannot confirm again, while the action is running", async () => {
    const onConfirm = vi.fn<() => void>();
    render(<Harness loading onConfirm={onConfirm} />);
    await screen.findByRole("alertdialog");

    await click(screen.getByRole("button", { name: "Cancel" }));
    await click(screen.getByRole("button", { name: /^Remove/ }));
    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
      await Promise.resolve();
    });

    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("renders nothing while closed", () => {
    render(
      <Confirm
        cancelLabel="Cancel"
        confirmLabel="Remove"
        description="The bookmarks stay."
        onConfirm={() => undefined}
        onOpenChange={() => undefined}
        open={false}
        title="Delete the folder?"
      />,
    );

    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

describe("Confirm keyboard trap", () => {
  it("moves Tab from the last stop to the first, before the browser moves the focus", async () => {
    render(<Harness onConfirm={() => undefined} />);
    await screen.findByRole("alertdialog");
    const last = screen.getByRole("button", { name: "Remove" });
    last.focus();

    const proceeded = fireEvent.keyDown(last, { key: "Tab" });

    expect(proceeded).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
  });

  it("moves Shift+Tab from the first stop to the last", async () => {
    render(<Harness onConfirm={() => undefined} />);
    await screen.findByRole("alertdialog");
    const first = screen.getByRole("button", { name: "Cancel" });
    first.focus();

    const proceeded = fireEvent.keyDown(first, { key: "Tab", shiftKey: true });

    expect(proceeded).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Remove" }));
  });

  it("leaves a Tab between the two buttons to the browser", async () => {
    render(<Harness onConfirm={() => undefined} />);
    await screen.findByRole("alertdialog");
    const first = screen.getByRole("button", { name: "Cancel" });
    first.focus();

    expect(fireEvent.keyDown(first, { key: "Tab" })).toBe(true);
    expect(document.activeElement).toBe(first);
  });
});
