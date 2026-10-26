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
