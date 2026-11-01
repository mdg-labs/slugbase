import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Button } from "../../src/index.ts";
import { Toolbar, ToolbarButton } from "../../src/components/ui/toolbar.tsx";
import { expectNoViolations } from "../support.tsx";

describe("Button", () => {
  it("renders a button that fires its click handler", async () => {
    const onClick = vi.fn();
    const { container } = render(<Button onClick={onClick}>Save</Button>);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onClick).toHaveBeenCalledTimes(1);
    await expectNoViolations(container);
  });

  it.each(["dark", "light"])("renders the destructive variant on the destructive button tokens in the %s theme", async (theme) => {
    document.documentElement.classList.add(theme);
    const { container } = render(<Button variant="destructive">Delete</Button>);

    const button = screen.getByRole("button", { name: "Delete" });
    expect(button.className).toContain("bg-destructive-button");
    expect(button.className).toContain("text-destructive-button-foreground");
    expect(button.className).not.toContain("text-white");
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

  describe("while loading", () => {
    it("announces itself as unavailable without being disabled, so it keeps the focus it has", () => {
      const { rerender } = render(<Button>Save</Button>);
      const button = screen.getByRole("button", { name: "Save" });
      button.focus();

      rerender(<Button loading>Save</Button>);

      expect(screen.getByRole("button", { name: /Save/ })).toBe(button);
      expect(button.hasAttribute("disabled")).toBe(false);
      expect(button.getAttribute("aria-disabled")).toBe("true");
      expect(button.hasAttribute("data-loading")).toBe(true);
      expect(document.activeElement).toBe(button);
    });

    it("runs no click handler, its own or an ancestor's", () => {
      const onClick = vi.fn();
      const onAncestor = vi.fn();
      render(
        <div onClick={onAncestor} role="presentation">
          <Button loading onClick={onClick}>
            Save
          </Button>
        </div>,
      );

      fireEvent.click(screen.getByRole("button", { name: /Save/ }));

      expect(onClick).not.toHaveBeenCalled();
      expect(onAncestor).not.toHaveBeenCalled();
    });

    it("submits no form from a submit button, and does again once it has stopped loading", () => {
      const onSubmit = vi.fn((event: React.SyntheticEvent) => {
        event.preventDefault();
      });
      const { rerender } = render(
        <form onSubmit={onSubmit}>
          <Button loading type="submit">
            Save
          </Button>
        </form>,
      );

      fireEvent.click(screen.getByRole("button", { name: /Save/ }));
      expect(onSubmit).not.toHaveBeenCalled();

      rerender(
        <form onSubmit={onSubmit}>
          <Button type="submit">Save</Button>
        </form>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    it("is still disabled where it is also disabled", () => {
      render(
        <Button disabled loading>
          Save
        </Button>,
      );

      expect(screen.getByRole("button", { name: /Save/ }).hasAttribute("disabled")).toBe(true);
    });

    it("stays aria-disabled as a toolbar button, whose own props say aria-disabled is false", () => {
      const onClick = vi.fn();
      const { rerender } = render(
        <Toolbar aria-label="Actions">
          <ToolbarButton onClick={onClick} render={<Button loading />}>
            Pin
          </ToolbarButton>
        </Toolbar>,
      );
      const button = screen.getByRole("button", { name: /Pin/ });

      expect(button.getAttribute("aria-disabled")).toBe("true");
      expect(button.hasAttribute("data-loading")).toBe(true);
      fireEvent.click(button);
      expect(onClick).not.toHaveBeenCalled();

      rerender(
        <Toolbar aria-label="Actions">
          <ToolbarButton onClick={onClick} render={<Button />}>
            Pin
          </ToolbarButton>
        </Toolbar>,
      );
      expect(screen.getByRole("button", { name: "Pin" }).getAttribute("aria-disabled")).not.toBe("true");
      fireEvent.click(screen.getByRole("button", { name: "Pin" }));
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("has no accessibility violations", async () => {
      const { container } = render(<Button loading>Save</Button>);

      await expectNoViolations(container);
    });
  });
});
