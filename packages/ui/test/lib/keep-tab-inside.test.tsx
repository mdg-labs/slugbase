import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { keepTabInside } from "../../src/lib/keep-tab-inside.ts";
import "../support.tsx";

// The stops keepTabInside wraps between are the ones the browser's Tab reaches. The failure scenarios are a control the browser
// skips counted as the first or last stop, so Tab from the real last stop leaves the popup instead of wrapping.

function Popup({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <div onKeyDown={keepTabInside} role="dialog" tabIndex={-1}>
      {children}
    </div>
  );
}

describe("keepTabInside", () => {
  it("does not count a control inside a closed details as a stop, but its summary", () => {
    render(
      <Popup>
        <button type="button">Save</button>
        <details>
          <summary>More</summary>
          <button type="button">Inside</button>
        </details>
      </Popup>,
    );
    const summary = screen.getByText("More");
    summary.focus();

    expect(fireEvent.keyDown(summary, { key: "Tab" })).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Save" }));
  });

  it("counts a control inside an open details as a stop", () => {
    render(
      <Popup>
        <button type="button">Save</button>
        <details open>
          <summary>More</summary>
          <button type="button">Inside</button>
        </details>
      </Popup>,
    );
    const summary = screen.getByText("More");
    summary.focus();

    expect(fireEvent.keyDown(summary, { key: "Tab" })).toBe(true);
    expect(document.activeElement).toBe(summary);
  });
});
