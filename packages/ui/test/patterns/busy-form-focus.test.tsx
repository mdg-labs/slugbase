import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FormOverlay, useBusyFormFocus } from "../../src/patterns/index.ts";
import { stubBrowserApis, stubMatchMedia } from "../support.tsx";

function Form({ busy }: { readonly busy: boolean }): ReactElement {
  const busyFocus = useBusyFormFocus(busy);
  return (
    <form {...busyFocus}>
      <input aria-label="Name" disabled={busy} />
      <input aria-label="Note" disabled={busy} />
      <button type="submit">Save</button>
    </form>
  );
}

function Harness({ busy, open = true }: { readonly busy: boolean; readonly open?: boolean }): ReactElement {
  return (
    <FormOverlay closeLabel="Close" onOpenChange={() => undefined} open={open} title="Rename">
      <Form busy={busy} />
    </FormOverlay>
  );
}

function overlay(): HTMLElement {
  return screen.getByRole("dialog", { name: "Rename" });
}

beforeEach(() => {
  stubBrowserApis();
  stubMatchMedia(false);
});

afterEach(() => {
  stubMatchMedia(false);
});

describe("useBusyFormFocus", () => {
  it("marks the form busy while it saves and not otherwise", async () => {
    const { rerender, container } = render(<Harness busy={false} />);
    await screen.findByRole("dialog");
    const form = (): HTMLElement => container.ownerDocument.querySelector("form") as HTMLElement;
    expect(form().hasAttribute("aria-busy")).toBe(false);

    rerender(<Harness busy />);
    expect(form().getAttribute("aria-busy")).toBe("true");

    rerender(<Harness busy={false} />);
    expect(form().hasAttribute("aria-busy")).toBe(false);
  });

  it("moves the focus of the field it disabled to the overlay, and back to that field when the save is refused", async () => {
    const { rerender } = render(<Harness busy={false} />);
    await screen.findByRole("dialog");
    const note = screen.getByLabelText("Note");
    act(() => {
      note.focus();
    });

    rerender(<Harness busy />);
    expect(document.activeElement).toBe(overlay());

    rerender(<Harness busy={false} />);
    expect(document.activeElement).toBe(screen.getByLabelText("Note"));
  });

  it("returns a focus that a browser dropped onto the page body after the field was disabled", async () => {
    const { rerender } = render(<Harness busy={false} />);
    await screen.findByRole("dialog");
    act(() => {
      screen.getByLabelText("Name").focus();
    });

    rerender(<Harness busy />);
    // What Chromium and Firefox do a frame later to a field that is disabled under the focus.
    act(() => {
      (document.activeElement as HTMLElement).blur();
    });
    expect(document.activeElement).toBe(document.body);

    rerender(<Harness busy={false} />);
    expect(document.activeElement).toBe(screen.getByLabelText("Name"));
  });

  it("moves a focus that is already on the page body into the overlay when the form turns busy", async () => {
    const { rerender } = render(<Harness busy={false} />);
    await screen.findByRole("dialog");
    act(() => {
      screen.getByLabelText("Name").focus();
      (document.activeElement as HTMLElement).blur();
    });
    expect(document.activeElement).toBe(document.body);

    rerender(<Harness busy />);

    expect(document.activeElement).toBe(overlay());
  });

  it("keeps the focus on a button that stays enabled", async () => {
    const { rerender } = render(<Harness busy={false} />);
    await screen.findByRole("dialog");
    const save = screen.getByRole("button", { name: "Save" });
    act(() => {
      save.focus();
    });

    rerender(<Harness busy />);
    expect(document.activeElement).toBe(save);

    rerender(<Harness busy={false} />);
    expect(document.activeElement).toBe(save);
  });

  it("does not take the focus back from where the member moved it while the form was busy", async () => {
    const { rerender } = render(<Harness busy={false} />);
    await screen.findByRole("dialog");
    act(() => {
      screen.getByLabelText("Name").focus();
    });
    rerender(<Harness busy />);
    const close = screen.getByRole("button", { name: "Close" });
    act(() => {
      close.focus();
    });

    rerender(<Harness busy={false} />);
    expect(document.activeElement).toBe(close);
  });

  it("does not pull the focus into an overlay that has closed", async () => {
    const { rerender } = render(<Harness busy={false} />);
    await screen.findByRole("dialog");
    act(() => {
      screen.getByLabelText("Name").focus();
    });
    rerender(<Harness busy />);

    rerender(<Harness busy={false} open={false} />);

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(document.activeElement?.closest("form")).toBeNull();
  });
});
