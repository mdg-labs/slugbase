import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TypedConfirm, matchesExpected } from "../../src/patterns/index.ts";
import { expectNoViolations, stubBrowserApis } from "../support.tsx";

function Harness({ onConfirm, loading = false, error, confirmDisabled = false }: { onConfirm: () => void; loading?: boolean; error?: string; confirmDisabled?: boolean }): ReactElement {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button onClick={() => { setOpen(true); }} type="button">
        Reopen
      </button>
      <TypedConfirm
        cancelLabel="Cancel"
        confirmDisabled={confirmDisabled}
        confirmLabel="Transfer ownership"
        description="Grace Hopper becomes an owner."
        destructive
        error={error}
        expected="Grace Hopper"
        inputLabel="Type Grace Hopper to confirm"
        loading={loading}
        onConfirm={onConfirm}
        onOpenChange={setOpen}
        open={open}
        title="Transfer ownership?"
      >
        <p>An option of the action.</p>
      </TypedConfirm>
    </>
  );
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
}

async function type(value: string): Promise<void> {
  await act(async () => {
    fireEvent.change(screen.getByRole("textbox", { name: "Type Grace Hopper to confirm" }), { target: { value } });
    await Promise.resolve();
  });
}

beforeEach(() => {
  stubBrowserApis();
});

describe("matchesExpected", () => {
  it("is true for the same characters and ignores the whitespace around them", () => {
    expect(matchesExpected("Grace Hopper", "Grace Hopper")).toBe(true);
    expect(matchesExpected("  Grace Hopper\n", "Grace Hopper")).toBe(true);
  });

  it("is false for any other text: another case, a part, an extra word, or nothing", () => {
    for (const typed of ["grace hopper", "Grace", "Grace Hopper Jr", "Grace  Hopper", ""]) {
      expect(matchesExpected(typed, "Grace Hopper")).toBe(false);
    }
  });

  it("is never true when there is nothing to type", () => {
    expect(matchesExpected("", "")).toBe(false);
    expect(matchesExpected("  ", " ")).toBe(false);
  });
});

describe("TypedConfirm", () => {
  it("is an alert dialog named by its title, described by what it does, with the options and the field in it", async () => {
    render(<Harness onConfirm={() => undefined} />);

    const dialog = await screen.findByRole("alertdialog", { name: "Transfer ownership?" });
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.getByText("Grace Hopper becomes an owner.").id).toBe(dialog.getAttribute("aria-describedby"));
    expect(screen.getByText("An option of the action.")).toBeTruthy();
    await expectNoViolations(document.body);
  });

  it("keeps the confirm button disabled until the expected text is typed, and confirms nothing on Enter before", async () => {
    const onConfirm = vi.fn<() => void>();
    render(<Harness onConfirm={onConfirm} />);
    await screen.findByRole("alertdialog");
    const confirm = screen.getByRole("button", { name: "Transfer ownership" });

    expect(confirm.hasAttribute("disabled")).toBe(true);
    await type("Grace Hop");
    expect(confirm.hasAttribute("disabled")).toBe(true);
    await act(async () => {
      fireEvent.submit(screen.getByRole("textbox").closest("form") ?? document.body);
      await Promise.resolve();
    });
    expect(onConfirm).not.toHaveBeenCalled();

    await type("Grace Hopper");
    expect(confirm.hasAttribute("disabled")).toBe(false);
  });

  it("keeps the confirm button disabled and confirms nothing on Enter while confirmDisabled is set, although the text matches", async () => {
    const onConfirm = vi.fn<() => void>();
    render(<Harness confirmDisabled onConfirm={onConfirm} />);
    await screen.findByRole("alertdialog");

    await type("Grace Hopper");
    expect(screen.getByRole("button", { name: "Transfer ownership" }).hasAttribute("disabled")).toBe(true);
    await act(async () => {
      fireEvent.submit(screen.getByRole("textbox").closest("form") ?? document.body);
      await Promise.resolve();
    });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("calls onConfirm once for the typed text, from the button and from Enter, and leaves closing it to the app", async () => {
    const onConfirm = vi.fn<() => void>();
    render(<Harness onConfirm={onConfirm} />);
    await screen.findByRole("alertdialog");
    await type("Grace Hopper");

    await click(screen.getByRole("button", { name: "Transfer ownership" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await act(async () => {
      fireEvent.submit(screen.getByRole("textbox").closest("form") ?? document.body);
      await Promise.resolve();
    });
    expect(onConfirm).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });

  it("closes without confirming for Cancel, and starts empty the next time it opens", async () => {
    const onConfirm = vi.fn<() => void>();
    render(<Harness onConfirm={onConfirm} />);
    await screen.findByRole("alertdialog");
    await type("Grace Hopper");

    await click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    await click(screen.getByRole("button", { name: "Reopen" }));

    expect(onConfirm).not.toHaveBeenCalled();
    expect((await screen.findByRole<HTMLInputElement>("textbox", { name: "Type Grace Hopper to confirm" })).value).toBe("");
    expect(screen.getByRole("button", { name: "Transfer ownership" }).hasAttribute("disabled")).toBe(true);
  });

  it("shows why the last attempt failed under the field", async () => {
    render(<Harness error="The request did not go through." onConfirm={() => undefined} />);
    await screen.findByRole("alertdialog");

    expect(screen.getByText("The request did not go through.")).toBeTruthy();
    expect(screen.getByRole("textbox").getAttribute("aria-invalid")).toBe("true");
  });

  it("cannot be dismissed, edited or confirmed again while the action is running", async () => {
    const onConfirm = vi.fn<() => void>();
    render(<Harness loading onConfirm={onConfirm} />);
    await screen.findByRole("alertdialog");

    await click(screen.getByRole("button", { name: "Cancel" }));
    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
      fireEvent.submit(screen.getByRole("textbox").closest("form") ?? document.body);
      await Promise.resolve();
    });

    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(screen.getByRole("textbox").hasAttribute("disabled")).toBe(true);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("renders nothing while closed", () => {
    render(
      <TypedConfirm
        cancelLabel="Cancel"
        confirmLabel="Go"
        description="d"
        expected="x"
        inputLabel="Type x"
        onConfirm={() => undefined}
        onOpenChange={() => undefined}
        open={false}
        title="t"
      />,
    );

    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
