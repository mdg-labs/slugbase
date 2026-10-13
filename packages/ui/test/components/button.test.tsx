import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Button } from "../../src/index.ts";
import { expectNoViolations } from "../support.tsx";

describe("Button", () => {
  it("renders a button that fires its click handler", async () => {
    const onClick = vi.fn();
    const { container } = render(<Button onClick={onClick}>Save</Button>);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onClick).toHaveBeenCalledTimes(1);
    await expectNoViolations(container);
  });

  it("does not fire while disabled", () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Save
      </Button>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onClick).not.toHaveBeenCalled();
  });

  it("renders as a link through the render prop", async () => {
    const { container } = render(<Button render={<a href="/go/docs" />}>Open</Button>);

    expect(screen.getByRole("link", { name: "Open" }).getAttribute("href")).toBe("/go/docs");
    await expectNoViolations(container);
  });
});
