import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dialog, DialogPopup, DialogTitle } from "../../src/components/ui/dialog.tsx";
import { FormOverlay } from "../../src/patterns/index.ts";
import { expectNoViolations, stubBrowserApis, stubMatchMedia } from "../support.tsx";

function Harness(): ReactElement {
  const [open, setOpen] = useState(true);
  return (
    <FormOverlay closeLabel="Close" description="Needs your password again." onOpenChange={setOpen} open={open} title="Confirm it is you">
      <input aria-label="Password" type="password" />
    </FormOverlay>
  );
}

beforeEach(() => {
  stubBrowserApis();
  stubMatchMedia(false);
});

afterEach(() => {
  stubMatchMedia(false);
});

describe("FormOverlay", () => {
  it("is a dialog named by its title, described, holding the form", async () => {
    render(<Harness />);

    const dialog = await screen.findByRole("dialog", { name: "Confirm it is you" });
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.getByLabelText("Password")).toBeTruthy();
  });

  it("is free of accessibility violations", async () => {
    render(<Harness />);
    await screen.findByRole("dialog", { name: "Confirm it is you" });

    await expectNoViolations(document.body);
  });

  it("puts focus on the first field, not on the close button", async () => {
    render(<Harness />);

    await screen.findByRole("dialog");
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText("Password"));
    });
  });

  it("closes from its close button", async () => {
    render(<Harness />);
    await screen.findByRole("dialog");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("is a bottom drawer on a narrow screen, with the same title, form and close button", async () => {
    stubMatchMedia(true);
    render(<Harness />);

    const dialog = await screen.findByRole("dialog", { name: "Confirm it is you" });
    expect(dialog.getAttribute("data-slot")).toBe("form-overlay");
    expect(dialog.closest("[data-slot=drawer-viewport]")).not.toBeNull();
    expect(screen.getByLabelText("Password")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("is a dialog, not a drawer, on a wide screen", async () => {
    render(<Harness />);

    const dialog = await screen.findByRole("dialog");
    expect(dialog.closest("[data-slot=dialog-viewport]")).not.toBeNull();
    expect(dialog.closest("[data-slot=drawer-viewport]")).toBeNull();
  });

  it("renders nothing while closed", () => {
    render(
      <FormOverlay closeLabel="Close" onOpenChange={() => undefined} open={false} title="Confirm it is you">
        <input aria-label="Password" />
      </FormOverlay>,
    );

    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("FormOverlay header action", () => {
  function WithAction(): ReactElement {
    return (
      <FormOverlay
        closeLabel="Close"
        headerAction={
          <div>
            <button type="button">Suggest</button>
            <p>A block of its own</p>
          </div>
        }
        onOpenChange={() => undefined}
        open
        title="Confirm it is you"
      >
        <input aria-label="Password" type="password" />
      </FormOverlay>
    );
  }

  for (const narrow of [false, true]) {
    const kind = narrow ? "sheet" : "dialog";

    it(`stands in the header of the ${kind}, outside the description, and is not what describes it`, async () => {
      stubMatchMedia(narrow);
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      render(<WithAction />);

      const dialog = await screen.findByRole("dialog", { name: "Confirm it is you" });
      const action = screen.getByRole("button", { name: "Suggest" });

      expect(action.closest("[data-slot=form-overlay-header-action]")).not.toBeNull();
      expect(action.closest("[data-slot$=-description]")).toBeNull();
      expect(dialog.querySelector("[data-slot$=-description]")).toBeNull();
      expect(dialog.getAttribute("aria-describedby")).toBeNull();
      expect(dialog.contains(action)).toBe(true);
      expect(errors).not.toHaveBeenCalled();
      await expectNoViolations(document.body);
    });

    it(`leaves the description of the ${kind} to the description when it has both`, async () => {
      stubMatchMedia(narrow);
      render(
        <FormOverlay
          closeLabel="Close"
          description="Needs your password again."
          headerAction={<button type="button">Suggest</button>}
          onOpenChange={() => undefined}
          open
          title="Confirm it is you"
        >
          <input aria-label="Password" type="password" />
        </FormOverlay>,
      );

      const dialog = await screen.findByRole("dialog", { name: "Confirm it is you" });
      const described = document.getElementById(dialog.getAttribute("aria-describedby") ?? "");

      expect(described?.textContent).toBe("Needs your password again.");
      expect(described?.contains(screen.getByRole("button", { name: "Suggest" }))).toBe(false);
    });
  }
});

describe("FormOverlay keyboard trap", () => {
  function Form(): ReactElement {
    return (
      <>
        <input aria-label="Password" type="password" />
        <input aria-label="Hidden" hidden />
        <button disabled type="button">
          Disabled
        </button>
        <button type="button">Save</button>
      </>
    );
  }

  async function open(narrow: boolean): Promise<HTMLElement> {
    stubMatchMedia(narrow);
    render(
      <FormOverlay closeLabel="Close" onOpenChange={() => undefined} open title="Confirm it is you">
        <Form />
      </FormOverlay>,
    );
    return screen.findByRole("dialog", { name: "Confirm it is you" });
  }

  for (const narrow of [false, true]) {
    const kind = narrow ? "sheet" : "dialog";

    it(`moves Tab from the last stop of the ${kind} to the first, before the browser moves the focus`, async () => {
      const overlay = await open(narrow);
      const stops = [screen.getByLabelText("Password"), screen.getByRole("button", { name: "Save" }), screen.getByRole("button", { name: "Close" })];
      const close = stops[2];
      close?.focus();

      const proceeded = fireEvent.keyDown(close ?? overlay, { key: "Tab" });

      expect(proceeded).toBe(false);
      expect(document.activeElement).toBe(stops[0]);
    });

    it(`moves Shift+Tab from the first stop of the ${kind} to the last`, async () => {
      await open(narrow);
      const password = screen.getByLabelText("Password");
      password.focus();

      const proceeded = fireEvent.keyDown(password, { key: "Tab", shiftKey: true });

      expect(proceeded).toBe(false);
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
    });

    it(`leaves a Tab between two stops of the ${kind} to the browser`, async () => {
      await open(narrow);
      const password = screen.getByLabelText("Password");
      password.focus();

      const proceeded = fireEvent.keyDown(password, { key: "Tab" });

      expect(proceeded).toBe(true);
      expect(document.activeElement).toBe(password);
    });
  }

  it("moves Shift+Tab from the dialog itself to its last stop", async () => {
    const overlay = await open(false);
    overlay.focus();
    expect(document.activeElement).toBe(overlay);

    const proceeded = fireEvent.keyDown(overlay, { key: "Tab", shiftKey: true });

    expect(proceeded).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
  });

  it("does not count a disabled or hidden field as a stop", async () => {
    await open(false);
    const save = screen.getByRole("button", { name: "Save" });
    const close = screen.getByRole("button", { name: "Close" });
    save.focus();

    expect(fireEvent.keyDown(save, { key: "Tab" })).toBe(true);
    close.focus();
    expect(fireEvent.keyDown(close, { key: "Tab" })).toBe(false);
    expect(document.activeElement).toBe(screen.getByLabelText("Password"));
  });
});

describe("FormOverlay with the focus on the page body", () => {
  function Page({ overlay = true, over = false }: { readonly overlay?: boolean; readonly over?: boolean }): ReactElement {
    return (
      <>
        <a href="#behind">Skip to content</a>
        <FormOverlay closeLabel="Close" onOpenChange={() => undefined} open={overlay} title="Confirm it is you">
          <input aria-label="Password" type="password" />
          <button type="button">Save</button>
        </FormOverlay>
        {over ? (
          <Dialog open>
            <DialogPopup showCloseButton={false}>
              <DialogTitle>A question</DialogTitle>
              <button type="button">Yes</button>
            </DialogPopup>
          </Dialog>
        ) : null}
      </>
    );
  }

  function toBody(): void {
    act(() => {
      (document.activeElement as HTMLElement).blur();
    });
    expect(document.activeElement).toBe(document.body);
  }

  for (const narrow of [false, true]) {
    const kind = narrow ? "sheet" : "dialog";

    it(`takes a Tab into the ${kind}, from where the browser goes on to its first stop`, async () => {
      stubMatchMedia(narrow);
      render(<Page />);
      const overlay = await screen.findByRole("dialog", { name: "Confirm it is you" });
      toBody();

      const proceeded = fireEvent.keyDown(document.body, { key: "Tab" });

      expect(proceeded).toBe(true);
      expect(document.activeElement).toBe(overlay);
    });

    it(`takes a Shift+Tab into the ${kind}, to its last stop`, async () => {
      stubMatchMedia(narrow);
      render(<Page />);
      await screen.findByRole("dialog", { name: "Confirm it is you" });
      toBody();

      const proceeded = fireEvent.keyDown(document.body, { key: "Tab", shiftKey: true });

      expect(proceeded).toBe(false);
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
    });
  }

  it("leaves a Tab alone while the focus is on a control of the page", async () => {
    render(<Page />);
    await screen.findByRole("dialog", { name: "Confirm it is you" });
    const behind = screen.getByText("Skip to content");
    act(() => {
      behind.focus();
    });

    fireEvent.keyDown(behind, { key: "Tab" });

    expect(document.activeElement).toBe(behind);
  });

  it("leaves a Tab to the modal that opened over it", async () => {
    render(<Page over />);
    await screen.findByRole("dialog", { name: "A question", hidden: true });
    toBody();

    fireEvent.keyDown(document.body, { key: "Tab" });

    expect(document.activeElement).toBe(document.body);
  });

  it("takes no key once the overlay has closed", async () => {
    const { rerender } = render(<Page />);
    await screen.findByRole("dialog", { name: "Confirm it is you" });
    rerender(<Page overlay={false} />);
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    toBody();

    fireEvent.keyDown(document.body, { key: "Tab" });

    expect(document.activeElement).toBe(document.body);
  });
});
