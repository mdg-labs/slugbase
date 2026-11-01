import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AlertDialog, AlertDialogPopup, AlertDialogTitle } from "../src/components/ui/alert-dialog.tsx";
import { Dialog, DialogPopup, DialogTitle } from "../src/components/ui/dialog.tsx";
import { ShortcutsProvider, useShortcut, type ShortcutBinding } from "../src/index.ts";
import { stubBrowserApis, stubMatchMedia } from "./support.tsx";

function Probe({ binding, onPress }: { binding: ShortcutBinding; onPress: () => void }): React.ReactElement {
  useShortcut(binding, onPress);
  return <input aria-label="Notes" />;
}

describe("useShortcut", () => {
  it("runs a single-key shortcut while single-key shortcuts are on", () => {
    const onPress = vi.fn();
    render(
      <ShortcutsProvider singleKey>
        <Probe binding={{ key: "c" }} onPress={onPress} />
      </ShortcutsProvider>,
    );

    fireEvent.keyDown(document.body, { key: "c" });

    expect(onPress).toHaveBeenCalledOnce();
  });

  it("skips a single-key shortcut while single-key shortcuts are off, and runs a modifier shortcut", () => {
    const single = vi.fn();
    const modified = vi.fn();
    render(
      <ShortcutsProvider singleKey={false}>
        <Probe binding={{ key: "c" }} onPress={single} />
        <Probe binding={{ key: "k", mod: true }} onPress={modified} />
      </ShortcutsProvider>,
    );

    fireEvent.keyDown(document.body, { key: "c" });
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    fireEvent.keyDown(document.body, { key: "K", metaKey: true });

    expect(single).not.toHaveBeenCalled();
    expect(modified).toHaveBeenCalledTimes(2);
  });

  it("runs again once the setting is switched back on", () => {
    const onPress = vi.fn();
    const { rerender } = render(
      <ShortcutsProvider singleKey={false}>
        <Probe binding={{ key: "c" }} onPress={onPress} />
      </ShortcutsProvider>,
    );
    fireEvent.keyDown(document.body, { key: "c" });
    expect(onPress).not.toHaveBeenCalled();

    rerender(
      <ShortcutsProvider singleKey>
        <Probe binding={{ key: "c" }} onPress={onPress} />
      </ShortcutsProvider>,
    );
    fireEvent.keyDown(document.body, { key: "c" });

    expect(onPress).toHaveBeenCalledOnce();
  });

  it("is on without a provider", () => {
    const onPress = vi.fn();
    render(<Probe binding={{ key: "c" }} onPress={onPress} />);
    fireEvent.keyDown(document.body, { key: "c" });
    expect(onPress).toHaveBeenCalledOnce();
  });

  it("ignores a single key typed into a text field and a single key pressed with a modifier", () => {
    const onPress = vi.fn();
    render(
      <ShortcutsProvider singleKey>
        <Probe binding={{ key: "c" }} onPress={onPress} />
      </ShortcutsProvider>,
    );

    fireEvent.keyDown(screen.getByRole("textbox", { name: "Notes" }), { key: "c" });
    fireEvent.keyDown(document.body, { key: "c", ctrlKey: true });
    fireEvent.keyDown(document.body, { key: "c", metaKey: true });
    fireEvent.keyDown(document.body, { key: "c", altKey: true });
    fireEvent.keyDown(document.body, { key: "c", repeat: true });
    fireEvent.keyDown(document.body, { key: "x" });

    expect(onPress).not.toHaveBeenCalled();
  });

  it("matches a single-key shortcut on its exact key only, and a modifier shortcut in either case", () => {
    const single = vi.fn();
    const modified = vi.fn();
    render(
      <ShortcutsProvider singleKey>
        <Probe binding={{ key: "c" }} onPress={single} />
        <Probe binding={{ key: "c", mod: true }} onPress={modified} />
      </ShortcutsProvider>,
    );

    fireEvent.keyDown(document.body, { key: "C", shiftKey: true });
    expect(single).not.toHaveBeenCalled();
    expect(modified).not.toHaveBeenCalled();

    fireEvent.keyDown(document.body, { key: "C", ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(document.body, { key: "c", ctrlKey: true });
    expect(modified).toHaveBeenCalledTimes(2);
    expect(single).not.toHaveBeenCalled();
  });

  it("matches a character that needs shift, such as ?", () => {
    const onPress = vi.fn();
    render(
      <ShortcutsProvider singleKey>
        <Probe binding={{ key: "?" }} onPress={onPress} />
      </ShortcutsProvider>,
    );

    fireEvent.keyDown(document.body, { key: "?", shiftKey: true });

    expect(onPress).toHaveBeenCalledOnce();
  });

  it("skips a single key pressed inside a dialog, a menu or a list box, and runs a modifier shortcut there", () => {
    const single = vi.fn();
    const modified = vi.fn();
    render(
      <ShortcutsProvider singleKey>
        <Probe binding={{ key: "c" }} onPress={single} />
        <Probe binding={{ key: "k", mod: true }} onPress={modified} />
        <div role="dialog">
          <button type="button">In the dialog</button>
        </div>
        <div role="menu">
          <button type="button">In the menu</button>
        </div>
        <div role="listbox">
          <button type="button">In the list box</button>
        </div>
      </ShortcutsProvider>,
    );

    for (const name of ["In the dialog", "In the menu", "In the list box"]) {
      fireEvent.keyDown(screen.getByRole("button", { name }), { key: "c" });
      fireEvent.keyDown(screen.getByRole("button", { name }), { key: "k", ctrlKey: true });
    }

    expect(single).not.toHaveBeenCalled();
    expect(modified).toHaveBeenCalledTimes(3);
  });

  it("stops listening when its component unmounts", () => {
    const onPress = vi.fn();
    const { unmount } = render(<Probe binding={{ key: "c" }} onPress={onPress} />);
    unmount();
    fireEvent.keyDown(document.body, { key: "c" });
    expect(onPress).not.toHaveBeenCalled();
  });

  describe("while a dialog is open", () => {
    beforeEach(() => {
      stubBrowserApis();
      stubMatchMedia(false);
    });

    function Page({ press, modifier, kind = "dialog" }: { press: () => void; modifier?: () => void; kind?: "dialog" | "alert" }): React.ReactElement {
      const [open, setOpen] = useState(false);
      return (
        <ShortcutsProvider singleKey>
          <Probe binding={{ key: "c" }} onPress={press} />
          <Probe binding={{ key: "k", mod: true }} onPress={modifier ?? ((): void => undefined)} />
          <button
            onClick={() => {
              setOpen(true);
            }}
            type="button"
          >
            Open
          </button>
          {kind === "dialog" ? (
            <Dialog onOpenChange={setOpen} open={open}>
              <DialogPopup>
                <DialogTitle>Confirm</DialogTitle>
                <button type="button">Inside</button>
              </DialogPopup>
            </Dialog>
          ) : (
            <AlertDialog onOpenChange={setOpen} open={open}>
              <AlertDialogPopup>
                <AlertDialogTitle>Sure</AlertDialogTitle>
                <button type="button">Inside</button>
              </AlertDialogPopup>
            </AlertDialog>
          )}
        </ShortcutsProvider>
      );
    }

    it.each(["dialog", "alert"] as const)("holds a single key back wherever focus is, on the page behind a %s too, and lets a modifier shortcut run", async (kind) => {
      const single = vi.fn();
      const modified = vi.fn();
      render(<Page kind={kind} modifier={modified} press={single} />);

      fireEvent.keyDown(document.body, { key: "c" });
      expect(single).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByRole("button", { name: "Open" }));
      await screen.findByRole(kind === "dialog" ? "dialog" : "alertdialog");

      // Focus on the page behind the dialog: the body, and a control outside it.
      (document.activeElement as HTMLElement | null)?.blur();
      expect(document.activeElement).toBe(document.body);
      fireEvent.keyDown(document.body, { key: "c" });
      fireEvent.keyDown(screen.getByRole("button", { name: "Open", hidden: true }), { key: "c" });
      expect(single).toHaveBeenCalledTimes(1);
      fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
      expect(modified).toHaveBeenCalledTimes(1);
    });

    it("runs a single key again once the dialog has closed", async () => {
      const single = vi.fn();
      render(<Page press={single} />);
      fireEvent.click(screen.getByRole("button", { name: "Open" }));
      await screen.findByRole("dialog");
      fireEvent.keyDown(document.body, { key: "c" });
      expect(single).not.toHaveBeenCalled();

      await act(async () => {
        fireEvent.keyDown(screen.getByRole("button", { name: "Inside" }), { key: "Escape" });
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).toBeNull();
      });
      fireEvent.keyDown(document.body, { key: "c" });

      expect(single).toHaveBeenCalledTimes(1);
    });

    it("does not count a toast, which is a non-modal alert dialog, as a dialog that is open", () => {
      const single = vi.fn();
      render(
        <>
          <Probe binding={{ key: "c" }} onPress={single} />
          <div aria-modal="false" role="alertdialog" />
        </>,
      );

      fireEvent.keyDown(document.body, { key: "c" });

      expect(single).toHaveBeenCalledTimes(1);
    });

    it("does not count a dialog that is closing or hidden as open", () => {
      const single = vi.fn();
      render(
        <>
          <Probe binding={{ key: "c" }} onPress={single} />
          <div data-closed="" role="dialog" />
          <div data-ending-style="" role="alertdialog" />
          <div hidden role="dialog" />
        </>,
      );

      fireEvent.keyDown(document.body, { key: "c" });

      expect(single).toHaveBeenCalledTimes(1);
    });
  });
});
