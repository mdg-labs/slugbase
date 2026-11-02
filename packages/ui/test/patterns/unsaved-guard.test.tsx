import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UnsavedGuard } from "../../src/patterns/index.ts";
import { expectNoViolations, stubBrowserApis } from "../support.tsx";

beforeEach(() => {
  stubBrowserApis();
});

function guard(onDiscard: () => void, onKeepEditing: () => void, open = true) {
  return (
    <UnsavedGuard
      description="Your changes are lost."
      discardLabel="Discard changes"
      keepEditingLabel="Keep editing"
      onDiscard={onDiscard}
      onKeepEditing={onKeepEditing}
      open={open}
      title="Discard your changes?"
    />
  );
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
}

describe("UnsavedGuard", () => {
  it("asks what closing loses, as an alert dialog", async () => {
    render(guard(() => undefined, () => undefined));

    expect(await screen.findByRole("alertdialog", { name: "Discard your changes?" })).toBeTruthy();
    expect(screen.getByText("Your changes are lost.")).toBeTruthy();
  });

  it("is free of accessibility violations", async () => {
    render(guard(() => undefined, () => undefined));
    await screen.findByRole("alertdialog", { name: "Discard your changes?" });

    await expectNoViolations(document.body);
  });

  it("discards only when the member says so", async () => {
    const onDiscard = vi.fn<() => void>();
    const onKeepEditing = vi.fn<() => void>();
    render(guard(onDiscard, onKeepEditing));

    await click(await screen.findByRole("button", { name: "Discard changes" }));

    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(onKeepEditing).not.toHaveBeenCalled();
  });

  it("goes back to the form when the member keeps editing", async () => {
    const onDiscard = vi.fn<() => void>();
    const onKeepEditing = vi.fn<() => void>();
    render(guard(onDiscard, onKeepEditing));

    await click(await screen.findByRole("button", { name: "Keep editing" }));

    expect(onKeepEditing).toHaveBeenCalledTimes(1);
    expect(onDiscard).not.toHaveBeenCalled();
  });

  it("returns focus to the element finalFocus names when the member keeps editing", async () => {
    const stays = document.createElement("button");
    stays.textContent = "Stays";
    document.body.append(stays);
    function Closing(): ReactElement {
      const [open, setOpen] = useState(true);
      return (
        <UnsavedGuard
          description="Your changes are lost."
          discardLabel="Discard changes"
          finalFocus={() => stays}
          keepEditingLabel="Keep editing"
          onDiscard={() => undefined}
          onKeepEditing={() => {
            setOpen(false);
          }}
          open={open}
          title="Discard your changes?"
        />
      );
    }
    render(<Closing />);
    await screen.findByRole("alertdialog");

    await click(screen.getByRole("button", { name: "Keep editing" }));

    await waitFor(() => {
      expect(document.activeElement).toBe(stays);
    });
    stays.remove();
  });
});
