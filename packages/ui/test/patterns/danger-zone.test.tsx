import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DangerZone } from "../../src/patterns/index.ts";
import { expectNoViolations } from "../support.tsx";

describe("DangerZone", () => {
  it("names the section, lists each action with its consequence, and runs the one that is pressed", async () => {
    const onSelect = vi.fn<() => void>();
    const { container } = render(
      <DangerZone
        items={[{ id: "leave", title: "Leave workspace", description: "You lose access to its bookmarks.", actionLabel: "Leave", onSelect }]}
        title="Danger zone"
      />,
    );

    expect(screen.getByRole("heading", { name: "Danger zone" })).toBeTruthy();
    expect(screen.getByText("Leave workspace")).toBeTruthy();
    expect(screen.getByText("You lose access to its bookmarks.")).toBeTruthy();
    await expectNoViolations(container);

    fireEvent.click(screen.getByRole("button", { name: "Leave" }));

    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("does not run an action that is disabled", () => {
    const onSelect = vi.fn<() => void>();
    render(<DangerZone items={[{ id: "leave", title: "Leave", description: "Why not.", actionLabel: "Leave", onSelect, disabled: true }]} title="Danger zone" />);

    fireEvent.click(screen.getByRole("button", { name: "Leave" }));

    expect(onSelect).not.toHaveBeenCalled();
  });
});
