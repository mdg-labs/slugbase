import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
