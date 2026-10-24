import { act, fireEvent, render, screen } from "@testing-library/react";
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
});
