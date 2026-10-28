import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SidePanel } from "../../src/patterns/index.ts";
import { expectNoViolations, stubBrowserApis, stubMatchMedia } from "../support.tsx";

function Harness({ description }: { description?: string }): ReactElement {
  const [open, setOpen] = useState(true);
  return (
    <SidePanel closeLabel="Close preview" description={description} onOpenChange={setOpen} open={open} title="Newest in reading">
      <p>Three bookmarks.</p>
    </SidePanel>
  );
}

beforeEach(() => {
  stubBrowserApis();
  stubMatchMedia(false);
});

afterEach(() => {
  stubMatchMedia(false);
});

describe("SidePanel", () => {
  it("is a dialog named by its title that holds its content", async () => {
    render(<Harness description="The latest ones." />);

    const dialog = await screen.findByRole("dialog", { name: "Newest in reading" });
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
    expect(dialog.textContent).toContain("Three bookmarks.");
    expect(dialog.closest("[data-slot=sheet-viewport]")).not.toBeNull();
  });

  it("is free of accessibility violations", async () => {
    render(<Harness description="The latest ones." />);
    await screen.findByRole("dialog");

    await expectNoViolations(document.body);
  });

  it("closes from its close button, named by the caller", async () => {
    render(<Harness />);
    await screen.findByRole("dialog");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("closes on Escape", async () => {
    render(<Harness />);
    const dialog = await screen.findByRole("dialog");

    await act(async () => {
      fireEvent.keyDown(dialog, { key: "Escape" });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("renders nothing while closed", () => {
    render(
      <SidePanel closeLabel="Close preview" onOpenChange={() => undefined} open={false} title="Newest in reading">
        <p>Three bookmarks.</p>
      </SidePanel>,
    );

    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("SidePanel keyboard trap", () => {
  function Panel(): ReactElement {
    return (
      <SidePanel closeLabel="Close preview" onOpenChange={() => undefined} open title="Newest in reading">
        <button type="button">Open all</button>
      </SidePanel>
    );
  }

  it("moves Tab from the last stop to the first, before the browser moves the focus", async () => {
    render(<Panel />);
    await screen.findByRole("dialog");
    const last = screen.getByRole("button", { name: "Close preview" });
    last.focus();

    const proceeded = fireEvent.keyDown(last, { key: "Tab" });

    expect(proceeded).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open all" }));
  });

  it("moves Shift+Tab from the first stop to the last", async () => {
    render(<Panel />);
    await screen.findByRole("dialog");
    const first = screen.getByRole("button", { name: "Open all" });
    first.focus();

    const proceeded = fireEvent.keyDown(first, { key: "Tab", shiftKey: true });

    expect(proceeded).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close preview" }));
  });

  it("leaves a Tab between the two stops to the browser", async () => {
    render(<Panel />);
    await screen.findByRole("dialog");
    const first = screen.getByRole("button", { name: "Open all" });
    first.focus();

    expect(fireEvent.keyDown(first, { key: "Tab" })).toBe(true);
    expect(document.activeElement).toBe(first);
  });
});
