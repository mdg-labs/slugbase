import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Wizard, type WizardProps } from "../../src/patterns/index.ts";
import { expectNoViolations, stubBrowserApis } from "../support.tsx";

function Steps(props: Partial<WizardProps>): React.ReactElement {
  return (
    <Wizard
      backLabel="Back"
      description="Three short steps."
      nextLabel="Next"
      onNext={() => undefined}
      step={2}
      stepCount={3}
      stepDescription="Who you are."
      stepLabel="Step 2 of 3"
      stepTitle="Your account"
      title="Set up"
      {...props}
    >
      <label>
        Name
        <input name="name" />
      </label>
    </Wizard>
  );
}

beforeEach(() => {
  stubBrowserApis();
});

describe("Wizard", () => {
  it("names the wizard and the current step, and reports the position as its progress", () => {
    render(<Steps />);

    expect(screen.getByRole("region", { name: "Set up" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Set up" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Your account" })).toBeTruthy();
    const progress = screen.getByRole("progressbar", { name: "Step 2 of 3" });
    expect(progress.getAttribute("aria-valuenow")).toBe("2");
    expect(progress.getAttribute("aria-valuemax")).toBe("3");
    expect(progress.getAttribute("aria-valuetext")).toBe("Step 2 of 3");
    expect(screen.getByText("Three short steps.")).toBeTruthy();
    expect(screen.getByText("Who you are.")).toBeTruthy();
  });

  it("shows Back only when it is given a way back, and calls it", () => {
    const onBack = vi.fn();
    const { rerender } = render(<Steps />);
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();

    rerender(<Steps onBack={onBack} />);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("goes on when the step is submitted by the Next button or the form", () => {
    const onNext = vi.fn();
    render(<Steps onNext={onNext} />);

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.submit(screen.getByLabelText("Name").closest("form") ?? document.body);

    expect(onNext).toHaveBeenCalledTimes(2);
  });

  it("does not go on and does not go back while a request is pending", () => {
    const onNext = vi.fn();
    const onBack = vi.fn();
    render(<Steps onBack={onBack} onNext={onNext} pending />);

    expect(screen.getByRole("button", { name: "Back" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: /^Next/ }).hasAttribute("data-loading")).toBe(true);
    fireEvent.submit(screen.getByLabelText("Name").closest("form") ?? document.body);

    expect(onNext).not.toHaveBeenCalled();
    expect(onBack).not.toHaveBeenCalled();
  });

  it("is free of accessibility violations in both themes", async () => {
    for (const dark of [false, true]) {
      document.documentElement.classList.toggle("dark", dark);
      const { container, unmount } = render(<Steps onBack={() => undefined} />);
      await expectNoViolations(container);
      unmount();
    }
  });
});
