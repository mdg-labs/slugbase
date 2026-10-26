import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState, type ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ShortcutSheet, type ShortcutSheetGroup } from "../../src/patterns/index.ts";
import { expectNoViolations, stubBrowserApis } from "../support.tsx";

const GROUPS: readonly ShortcutSheetGroup[] = [
  {
    id: "app",
    title: "Anywhere",
    shortcuts: [
      { id: "new", label: "New bookmark", keys: [["C"]] },
      { id: "home", label: "Go to Home", keys: [["G", "H"]], sequence: true },
    ],
  },
  {
    id: "list",
    title: "In the list",
    shortcuts: [
      { id: "move", label: "Move focus", keys: [["J"], ["K"]] },
      { id: "tab", label: "Open in a new tab", keys: [["Ctrl", "Enter"], ["⌘", "Enter"]] },
    ],
  },
];

function Harness({ onOpenChange = () => undefined }: { onOpenChange?: (open: boolean) => void }): ReactElement {
  const [open, setOpen] = useState(true);
  return (
    <ShortcutSheet
      closeLabel="Close the list"
      description="Keys that work anywhere in the app."
      groups={GROUPS}
      onOpenChange={(next) => {
        setOpen(next);
        onOpenChange(next);
      }}
      open={open}
      thenLabel="then"
      title="Keyboard shortcuts"
    />
  );
}

beforeEach(() => {
  stubBrowserApis();
});

describe("ShortcutSheet", () => {
  it("is a dialog named by its title and described by its description", async () => {
    render(<Harness />);

    const dialog = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    expect(screen.getByText("Keys that work anywhere in the app.").id).toBe(dialog.getAttribute("aria-describedby"));
  });

  it("is free of accessibility violations", async () => {
    render(<Harness />);
    await screen.findByRole("dialog", { name: "Keyboard shortcuts" });

    await expectNoViolations(document.body);
  });

  it("lists each group's shortcuts with their keys in kbd elements", async () => {
    render(<Harness />);
    const dialog = await screen.findByRole("dialog");

    const groups = within(dialog).getAllByRole("region");
    expect(groups.map((group) => group.getAttribute("aria-labelledby"))).toEqual(["shortcut-group-app", "shortcut-group-list"]);
    expect(within(dialog).getByRole("heading", { name: "Anywhere" })).toBeDefined();
    const term = within(dialog).getByText("New bookmark");
    expect(within(term.closest("div") as HTMLElement).getByText("C").tagName).toBe("KBD");
    const move = within(dialog).getByText("Move focus").closest("div") as HTMLElement;
    expect(Array.from(move.querySelectorAll("kbd[data-slot='kbd']")).map((key) => key.textContent)).toEqual(["J", "K"]);
    const tab = within(dialog).getByText("Open in a new tab").closest("div") as HTMLElement;
    expect(Array.from(tab.querySelectorAll("kbd[data-slot='kbd']")).map((key) => key.textContent)).toEqual(["Ctrl", "Enter", "⌘", "Enter"]);
  });

  it("puts the word between the keys of a sequence and nowhere else", async () => {
    render(<Harness />);
    const dialog = await screen.findByRole("dialog");

    const home = within(dialog).getByText("Go to Home").closest("div") as HTMLElement;
    expect(home.textContent).toContain("Gthen");
    expect(within(dialog).getAllByText("then")).toHaveLength(1);
  });

  it("names its close button for the page's language and reports closing", async () => {
    const onOpenChange = vi.fn<(open: boolean) => void>();
    render(<Harness onOpenChange={onOpenChange} />);
    await screen.findByRole("dialog");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Close the list" }));
      await Promise.resolve();
    });

    expect(onOpenChange).toHaveBeenCalledWith(false);
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("renders nothing while closed", () => {
    render(<ShortcutSheet closeLabel="Close" groups={GROUPS} onOpenChange={() => undefined} open={false} thenLabel="then" title="Keyboard shortcuts" />);

    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
