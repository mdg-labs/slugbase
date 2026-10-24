import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ShortcutsProvider, useShortcut, type ShortcutBinding } from "../src/index.ts";
import "./support.tsx";

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
});
