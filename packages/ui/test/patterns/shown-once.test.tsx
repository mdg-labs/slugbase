import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ShownOnce } from "../../src/patterns/index.ts";
import { expectNoViolations } from "../support.tsx";

const CODES = ["ABCDEFGH23", "JKLMNPQR45", "STUVWXYZ67"] as const;

function Codes({ values = CODES }: { values?: readonly string[] }): React.ReactElement {
  const [acknowledged, setAcknowledged] = useState(false);
  return (
    <>
      <ShownOnce
        acknowledgeLabel="I have saved these codes"
        acknowledged={acknowledged}
        copiedLabel="Copied"
        copyLabel="Copy all codes"
        label="Backup codes"
        note="They are not shown again."
        onAcknowledgedChange={setAcknowledged}
        values={values}
      />
      <button disabled={!acknowledged} type="button">
        Done
      </button>
    </>
  );
}

describe("ShownOnce", () => {
  it("lists several values, and offers them all in one copy field", () => {
    render(<Codes />);

    const list = screen.getByRole("list", { name: "Backup codes" });
    expect(within(list).getAllByRole("listitem").map((item) => item.textContent)).toEqual([...CODES]);
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Backup codes" }).value).toBe(CODES.join(" "));
    expect(screen.getByText("They are not shown again.")).toBeTruthy();
  });

  it("shows one value in the copy field alone", () => {
    render(<Codes values={["secret-token"]} />);

    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Backup codes" }).value).toBe("secret-token");
  });

  it("copies every value", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<Codes />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy all codes" }));
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith(CODES.join(" "));
  });

  it("starts unacknowledged, so the Done it gates stays disabled until the box is ticked", () => {
    render(<Codes />);
    const box = screen.getByRole("checkbox", { name: "I have saved these codes" });

    expect(box.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Done" }).disabled).toBe(true);

    fireEvent.click(box);

    expect(box.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Done" }).disabled).toBe(false);
  });

  it("is free of accessibility violations in both themes", async () => {
    for (const dark of [false, true]) {
      document.documentElement.classList.toggle("dark", dark);
      const { container, unmount } = render(<Codes />);
      await expectNoViolations(container);
      unmount();
    }
  });
});
