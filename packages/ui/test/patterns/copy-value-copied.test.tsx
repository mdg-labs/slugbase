import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CopyValue } from "../../src/patterns/index.ts";
import "../support.tsx";

function Value({ onCopied }: { onCopied: () => void }): React.ReactElement {
  return <CopyValue copiedLabel="Copied" copyLabel="Copy address" label="Address" onCopied={onCopied} value="https://slugbase.example/go/mail" />;
}

async function press(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Copy address" }));
    await Promise.resolve();
  });
}

describe("CopyValue onCopied", () => {
  it("is called once the value is on the clipboard", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: () => Promise.resolve() } });
    const onCopied = vi.fn();
    render(<Value onCopied={onCopied} />);

    await press();

    expect(onCopied).toHaveBeenCalledTimes(1);
  });

  it("is not called when the clipboard refuses the value", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: () => Promise.reject(new DOMException("denied", "NotAllowedError")) } });
    const onCopied = vi.fn();
    render(<Value onCopied={onCopied} />);

    await press();

    expect(onCopied).not.toHaveBeenCalled();
  });

  it("marks the value as text that is not translated", () => {
    render(<Value onCopied={() => undefined} />);

    expect(screen.getByRole("textbox", { name: "Address" }).getAttribute("translate")).toBe("no");
  });
});
